#!/usr/bin/env bash
# Build the VS Code OS image for 64-bit Raspberry Pi boards.
#
# A Raspberry Pi cannot boot an ISO: its firmware reads the first FAT
# partition of the SD card or USB drive directly, so the deliverable is a raw
# disk image you write with dd or Raspberry Pi Imager. The result is the
# installed system - there is no separate installer step, and the root
# filesystem grows to fill the media on first boot.
#
# Runs as root. Native on an aarch64 host; on x86-64 it needs binfmt/qemu
# registered for aarch64 (see the README) because it chroots into the image.
#
# Usage: sudo rpi/build-image.sh [-o out-dir] [-w work-dir] [-v version]

set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly RPI_DIR="${REPO_ROOT}/rpi"
readonly ROOTFS_COMMON="${REPO_ROOT}/rootfs-common"

# Fixed MBR disk identifier: it makes the PARTUUIDs in cmdline.txt and fstab
# deterministic, so the image boots the same from SD or USB on any board.
readonly DISK_ID="0xc0de0501"
readonly PARTUUID_PREFIX="c0de0501"
readonly BOOT_LABEL="VSCODEOSBT"     # FAT labels are limited to 11 characters
readonly ROOT_LABEL="VSCODEOS_ROOT"

readonly ALARM_URL="${ALARM_URL:-http://os.archlinuxarm.org/os/ArchLinuxARM-rpi-aarch64-latest.tar.gz}"

OUT_DIR="${REPO_ROOT}/out"
WORK_DIR="${REPO_ROOT}/work-rpi"
BUILD_VERSION="${IMAGE_VERSION:-${ISO_VERSION:-$(date +%Y.%m.%d)}}"
# The image only has to hold the installed system - the root filesystem grows to
# fill the card on first boot - but it has to hold all of it: the Arch Linux ARM
# base, the package set, and roughly 600 MiB of unpacked VS Code. 6 GiB leaves
# comfortable headroom and still fits the smallest card worth using (8 GB).
IMAGE_SIZE_MB="${IMAGE_SIZE_MB:-6144}"
BOOT_SIZE_MB="${BOOT_SIZE_MB:-512}"

msg() { printf '\e[38;5;39m==>\e[0m %s\n' "$*"; }
die() { printf '\e[38;5;203merror\e[0m %s\n' "$*" >&2; exit 1; }

LOOP=""
ROOT_MNT=""

while (( $# )); do
    case "$1" in
        -o|--out)     OUT_DIR="$2"; shift 2 ;;
        -w|--work)    WORK_DIR="$2"; shift 2 ;;
        -v|--version) BUILD_VERSION="$2"; shift 2 ;;
        -h|--help)    sed -n '2,13p' "$0"; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

# --------------------------------------------------------------------------
# preflight
# --------------------------------------------------------------------------

OUT_DIR="$(readlink -m -- "${OUT_DIR}")"
WORK_DIR="$(readlink -m -- "${WORK_DIR}")"

(( EUID == 0 )) || die "this build must run as root (it partitions and chroots)"

missing=()
for tool in bsdtar losetup sfdisk mkfs.vfat mkfs.ext4 xz curl \
            mountpoint udevadm findmnt lsblk partx truncate; do
    command -v "${tool}" >/dev/null || missing+=("${tool}")
done
(( ${#missing[@]} == 0 )) ||
    die "missing tools: ${missing[*]} (Debian/Ubuntu: apt-get install libarchive-tools dosfstools e2fsprogs xz-utils util-linux curl)"

if [[ "$(uname -m)" != "aarch64" ]]; then
    [[ -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]] ||
        die "building on $(uname -m) needs qemu-user-static binfmt for aarch64 - run an aarch64 host instead, or register it with: docker run --privileged --rm tonistiigi/binfmt --install arm64"
    msg "cross-building via qemu-user-static (slow; an aarch64 runner is much faster)"
fi

# --------------------------------------------------------------------------
# teardown
# --------------------------------------------------------------------------

# udev and systemd both poke at a freshly written loop device, so a mount can
# still be busy for a moment after the last write. Retry before giving up.
umount_tree() {
    local target="$1" tries=0
    mountpoint -q "${target}" || return 0
    until umount -R "${target}" 2>/dev/null; do
        (( tries++ < 10 )) || return 1
        sync
        sleep 1
        mountpoint -q "${target}" || return 0
    done
    return 0
}

# Processes that were started inside the image. pacman-key leaves a gpg-agent
# and a dirmngr running behind it - that is how GnuPG works, the agent outlives
# the command that needed it - and they hold the chroot's /dev busy through
# their own stdio long after the last chroot has exited. That is what used to
# fail the build on the very last step, with the image otherwise complete.
chroot_pids() {
    local proc root
    for proc in /proc/[0-9]*; do
        root="$(readlink "${proc}/root" 2>/dev/null)" || continue
        [[ "${root}" == "${ROOT_MNT}" || "${root}" == "${ROOT_MNT}/"* ]] || continue
        printf '%s\n' "${proc##*/}"
    done
}

# Best-effort answer to "who is still holding this?", for the build log.
mount_holders() {
    local target="$1" proc link dest
    for proc in /proc/[0-9]*; do
        for link in "${proc}/root" "${proc}/cwd" "${proc}"/fd/*; do
            dest="$(readlink "${link}" 2>/dev/null)" || continue
            [[ "${dest}" == "${target}" || "${dest}" == "${target}/"* ]] || continue
            printf '    pid %s (%s)\n' "${proc##*/}" \
                "$(tr -d '\0' < "${proc}/comm" 2>/dev/null)"
            break
        done
    done
}

# Ask everything still running inside the image to leave, then insist.
stop_chroot_processes() {
    [[ -n "${ROOT_MNT}" && -d "${ROOT_MNT}" ]] || return 0
    # GnuPG has a supported way of being asked; killing the agent takes the
    # dirmngr with it and leaves the keyring in the image intact.
    chroot "${ROOT_MNT}" gpgconf --homedir /etc/pacman.d/gnupg --kill all \
        >/dev/null 2>&1 || true

    local -a pids
    local signal waited
    for signal in TERM KILL; do
        for (( waited = 0; waited < 5; waited++ )); do
            mapfile -t pids < <(chroot_pids)
            (( ${#pids[@]} )) || return 0
            kill "-${signal}" "${pids[@]}" 2>/dev/null || true
            sleep 1
        done
    done
    mapfile -t pids < <(chroot_pids)
    (( ${#pids[@]} == 0 ))
}

cleanup() {
    local rc=$?
    set +e
    if [[ -n "${ROOT_MNT}" && -d "${ROOT_MNT}" ]]; then
        local m
        stop_chroot_processes
        for m in dev/pts dev proc sys run var/cache/pacman/pkg boot ""; do
            # A lazy unmount is acceptable here but not on the success path:
            # this only runs when the build has already failed.
            umount_tree "${ROOT_MNT}/${m}" || umount -Rl "${ROOT_MNT}/${m}"
        done
    fi
    if [[ -n "${LOOP}" ]]; then
        partx --delete "${LOOP}" 2>/dev/null
        losetup -d "${LOOP}" 2>/dev/null
    fi
    (( rc != 0 )) && printf '\e[38;5;203mbuild failed (exit %s)\e[0m\n' "${rc}" >&2
    return 0
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# fetch the Arch Linux ARM base
# --------------------------------------------------------------------------

# An aborted earlier run can leave the image's bind mounts behind; drop them
# before deleting anything so rm never recurses into a mounted filesystem.
if [[ -d "${WORK_DIR}" ]]; then
    while read -r mp; do
        [[ -n "${mp}" ]] || continue
        umount -R "${mp}" 2>/dev/null || umount -Rl "${mp}" 2>/dev/null || true
    done < <(findmnt -rno TARGET | awk -v d="${WORK_DIR}/" 'index($0, d) == 1' | sort -r)
fi

# The work directory may itself be a mount point (CI hands the build a volume),
# and removing a mount point fails with EBUSY - empty it instead of deleting it.
mkdir -p "${WORK_DIR}" "${OUT_DIR}"
find "${WORK_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
readonly TARBALL="${WORK_DIR}/alarm-rootfs.tar.gz"

# Free space on the filesystem holding a given path, in MiB.
free_mb() { df -B1M --output=avail "$1" | awk 'NR == 2 { print $1 }'; }

# The work directory holds the raw image, the base tarball and the package
# cache all at once. Say so now rather than through whichever write happens to
# hit ENOSPC first, half an hour in.
work_needed_mb=$(( IMAGE_SIZE_MB + 4096 ))
work_free_mb="$(free_mb "${WORK_DIR}")"
(( work_free_mb >= work_needed_mb )) ||
    die "${WORK_DIR} has ${work_free_mb} MiB free; this build needs about ${work_needed_mb} MiB - point -w at a roomier filesystem"

msg "downloading the Arch Linux ARM base for Raspberry Pi"
curl --fail --location --retry 5 --retry-delay 3 --retry-connrefused \
    --progress-bar -o "${TARBALL}" "${ALARM_URL}"

if curl --fail --silent --location --retry 3 -o "${TARBALL}.md5" "${ALARM_URL}.md5"; then
    msg "verifying checksum"
    expected="$(awk 'NR == 1 { print $1 }' "${TARBALL}.md5")"
    actual="$(md5sum "${TARBALL}" | awk '{ print $1 }')"
    [[ -n "${expected}" && "${expected}" == "${actual}" ]] ||
        die "checksum mismatch on the Arch Linux ARM tarball (expected ${expected:-none}, got ${actual})"
else
    msg "no published checksum available - continuing without verification"
fi

# --------------------------------------------------------------------------
# lay out the image
# --------------------------------------------------------------------------

readonly IMAGE="${WORK_DIR}/VSCodeOS-${BUILD_VERSION}-aarch64-rpi.img"
msg "creating a ${IMAGE_SIZE_MB} MiB image"
rm -f "${IMAGE}"
truncate -s "${IMAGE_SIZE_MB}M" "${IMAGE}"

# An MBR table with a FAT32 boot partition is what every Pi bootloader can
# read, including the older ones that do not understand GPT.
sfdisk --quiet "${IMAGE}" <<EOF
label: dos
label-id: ${DISK_ID}

start=8MiB,  size=${BOOT_SIZE_MB}MiB, type=c, bootable
start=$(( 8 + BOOT_SIZE_MB ))MiB, type=83
EOF

LOOP="$(losetup --find --partscan --show "${IMAGE}")"
udevadm settle || true
# --partscan does not always produce the partition nodes (it depends on the
# kernel's loop module parameters), so ask partx explicitly when it has not.
if [[ ! -b "${LOOP}p1" ]]; then
    partx --add "${LOOP}" || true
    udevadm settle || true
fi
tries=0
while [[ ! -b "${LOOP}p2" ]] && (( tries++ < 20 )); do sleep 0.5; done
[[ -b "${LOOP}p1" && -b "${LOOP}p2" ]] || die "loop partitions did not appear for ${LOOP}"
msg "attached as ${LOOP}"

mkfs.vfat -F32 -n "${BOOT_LABEL}" "${LOOP}p1" >/dev/null
# -m 1: ext4 holds back 5% for root by default, which is worth having on a
# server and pure waste here - it would be a gigabyte and a half on a 32 GB card
# after the first-boot expansion, and a few hundred MiB during this build.
mkfs.ext4 -q -F -m 1 -L "${ROOT_LABEL}" "${LOOP}p2"

ROOT_MNT="${WORK_DIR}/root"
mkdir -p "${ROOT_MNT}"
mount "${LOOP}p2" "${ROOT_MNT}"
mkdir -p "${ROOT_MNT}/boot"
mount "${LOOP}p1" "${ROOT_MNT}/boot"

# --------------------------------------------------------------------------
# unpack the base system
# --------------------------------------------------------------------------

msg "unpacking the base system (its /boot lands on the FAT partition)"
# bsdtar preserves ownership and capabilities; it warns about the attributes
# FAT cannot store, which is expected rather than fatal.
bsdtar -xpf "${TARBALL}" -C "${ROOT_MNT}" || true
[[ -x "${ROOT_MNT}/usr/bin/pacman" ]] || die "the base tarball did not unpack correctly"

# --------------------------------------------------------------------------
# package installation inside the image
# --------------------------------------------------------------------------

# --rbind carries /dev/pts and friends along; --make-rslave stops our unmounts
# from propagating back to the host's shared mounts, which is what otherwise
# leaves these "target is busy" on the way out.
mount --rbind /dev "${ROOT_MNT}/dev"
mount --make-rslave "${ROOT_MNT}/dev"
mount -t proc proc "${ROOT_MNT}/proc"
mount -t sysfs sys "${ROOT_MNT}/sys"
mount --make-rslave "${ROOT_MNT}/sys"
mount -t tmpfs tmpfs "${ROOT_MNT}/run"

# pacman downloads every package into /var/cache/pacman/pkg and leaves it
# there, so an image sized for the installed system would also be carrying a
# compressed second copy of it - well over a gigabyte, and the reason the build
# used to run out of room part-way through unpacking VS Code. Keep the cache in
# the work directory instead; nothing in the finished image needs it.
mkdir -p "${WORK_DIR}/pkgcache" "${ROOT_MNT}/var/cache/pacman/pkg"
mount --bind "${WORK_DIR}/pkgcache" "${ROOT_MNT}/var/cache/pacman/pkg"

# DNS for the chroot. The host's /etc/resolv.conf usually points at a local
# stub - systemd-resolved's 127.0.0.53 on the GitHub runners - and neither that
# stub's runtime directory nor its socket exist under the chroot's fresh tmpfs
# /run, so copying the file verbatim leaves the image unable to resolve a
# mirror. Take the upstream servers systemd-resolved publishes instead, ignore
# loopback entries, and fall back to public resolvers when nothing usable is
# left. pacman only ever talks to public mirrors from here.
host_nameservers() {
    local src
    for src in /run/systemd/resolve/resolv.conf /etc/resolv.conf; do
        [[ -s "${src}" ]] || continue
        awk '$1 == "nameserver" && $2 !~ /^(127\.|::1$)/ { print "nameserver", $2 }' "${src}"
    done | awk '!seen[$0]++'
}

nameservers="$(host_nameservers)"
if [[ -z "${nameservers}" ]]; then
    msg "the host offers no non-loopback nameserver - using public resolvers"
    nameservers=$'nameserver 1.1.1.1\nnameserver 8.8.8.8'
fi
rm -f "${ROOT_MNT}/etc/resolv.conf"
printf '%s\n' "${nameservers}" > "${ROOT_MNT}/etc/resolv.conf"
chmod 0644 "${ROOT_MNT}/etc/resolv.conf"

in_chroot() { chroot "${ROOT_MNT}" /bin/bash -euo pipefail -c "$*"; }

# An ENOSPC inside the image surfaces as hundreds of write errors from tar or
# pacman with the actual cause - an image too small for what is going into it -
# nowhere in sight. Check before the steps that fill it, and name the knob.
require_image_space() {
    local needed_mb="$1" what="$2" available_mb
    available_mb="$(free_mb "${ROOT_MNT}")"
    if (( available_mb < needed_mb )); then
        die "${what} needs about ${needed_mb} MiB but the image has ${available_mb} MiB left - rebuild with IMAGE_SIZE_MB=$(( IMAGE_SIZE_MB + needed_mb - available_mb + 512 ))"
    fi
}

# Every package below comes over the network, so prove name resolution works
# before pacman fails several minutes in with a wall of mirror errors.
msg "checking that the image can resolve a mirror"
in_chroot "getent hosts mirror.archlinuxarm.org >/dev/null" || {
    printf 'resolv.conf inside the image:\n' >&2
    sed 's/^/    /' "${ROOT_MNT}/etc/resolv.conf" >&2
    die "the chroot cannot resolve mirror.archlinuxarm.org - check the host's DNS"
}

msg "initialising the package keyring"
in_chroot "pacman-key --init && pacman-key --populate archlinuxarm"

# The rpi-aarch64 base tarball boots the mainline linux-aarch64 kernel through
# U-Boot, and linux-rpi conflicts with both halves of that chain: linux-aarch64
# provides 'linux', and uboot-raspberrypi owns /boot/kernel8.img, which is where
# linux-rpi puts the kernel itself. pacman asks whether to remove a conflicting
# package and --noconfirm answers "no", which aborts the whole transaction, so
# drop them explicitly up front. Our config.txt has the firmware load the kernel
# directly (kernel=kernel8.img), so U-Boot has no role in this image either way.
#
# This runs before the system upgrade on purpose: upgrading a kernel that is
# about to be deleted costs a download and a full mkinitcpio run, and under
# qemu-user emulation that is several minutes.
displaced=()
for pkg in uboot-raspberrypi linux-aarch64; do
    if in_chroot "pacman -Q ${pkg} >/dev/null 2>&1"; then
        displaced+=("${pkg}")
    fi
done
if (( ${#displaced[@]} )); then
    msg "removing the base tarball's boot chain (${displaced[*]}) in favour of linux-rpi"
    # One transaction: uboot-raspberrypi has to go before, or together with, the
    # kernel it loads, and pacman only checks dependencies once per transaction.
    in_chroot "pacman -R --noconfirm ${displaced[*]}"
fi

msg "updating the base system"
in_chroot "pacman -Syu --noconfirm"

mapfile -t packages < <(grep -vE '^[[:space:]]*(#|$)' "${RPI_DIR}/packages.aarch64")

# Arch Linux ARM renames packages now and then - raspberrypi-firmware became
# raspberrypi-utils, for one - and pacman aborts on the first unknown target
# without saying whether any others are wrong. Name them all up front.
msg "checking the package list against the repositories"
unknown="$({ in_chroot "pacman -Si ${packages[*]} >/dev/null" 2>&1 || true; } |
           sed -n -e "s/^error: package '\(.*\)' was not found$/\1/p" \
                  -e 's/^error: target not found: //p')"

# A name 'pacman -Si' rejects can still be installable: when upstream folds one
# package into another it leaves the old name behind as a 'provides' (mesa
# absorbed libva-mesa-driver that way), and group names are not packages either.
# pacman resolves both, so those only deserve a warning - failing the build on
# them would be stricter than the installer that follows. A name nothing
# provides really has been dropped, and that still has to stop the build.
gone=()
while read -r name; do
    [[ -n "${name}" ]] || continue
    if in_chroot "pacman -Sp --noconfirm ${name} >/dev/null 2>&1"; then
        msg "  ${name} is no longer a package of its own, but something still provides it"
    else
        gone+=("${name}")
    fi
done <<< "${unknown}"
(( ${#gone[@]} == 0 )) ||
    die "not in the Arch Linux ARM repositories (renamed or dropped upstream?): ${gone[*]}"

msg "installing the VS Code OS package set"
in_chroot "pacman -S --noconfirm --needed ${packages[*]}"
msg "image root filesystem: $(free_mb "${ROOT_MNT}") MiB free after the package set"

# --------------------------------------------------------------------------
# overlays
# --------------------------------------------------------------------------

msg "applying the shared kiosk overlay"
# The account database is left alone here: packages installed above may have
# created system users, and overwriting /etc/passwd would strip them. The
# kiosk account is created with useradd further down instead.
staging="${WORK_DIR}/overlay"
rm -rf "${staging}"
cp -a "${ROOTFS_COMMON}" "${staging}"
rm -f "${staging}"/etc/{passwd,shadow,group,gshadow}
cp -a "${staging}/." "${ROOT_MNT}/"
rm -rf "${staging}"

msg "applying the Raspberry Pi overlay"
cp -a "${RPI_DIR}/overlay/." "${ROOT_MNT}/"
install -Dm0644 "${RPI_DIR}/boot/config.txt"  "${ROOT_MNT}/boot/config.txt"
install -Dm0644 "${RPI_DIR}/boot/cmdline.txt" "${ROOT_MNT}/boot/cmdline.txt"

# These services come from the shared overlay but have no meaning on a Pi:
# there is no ACPI, and TLP is for laptops. Leaving the symlinks would just
# produce failed units at every boot.
rm -f "${ROOT_MNT}/etc/systemd/system/multi-user.target.wants/acpid.service"
rm -f "${ROOT_MNT}/etc/systemd/system/multi-user.target.wants/tlp.service"

# cmdline.txt and fstab address the root filesystem by PARTUUID, which is
# derived from the MBR disk identifier written above. If they ever drift apart
# the Pi boots to a kernel panic, so check it here rather than on the hardware.
for f in "${ROOT_MNT}/boot/cmdline.txt" "${ROOT_MNT}/etc/fstab"; do
    grep -q "${PARTUUID_PREFIX}-02" "${f}" ||
        die "${f##*/} does not reference PARTUUID ${PARTUUID_PREFIX}-02 - it would not boot"
done
grep -q "${PARTUUID_PREFIX}-01" "${ROOT_MNT}/etc/fstab" ||
    die "fstab does not reference the boot partition PARTUUID ${PARTUUID_PREFIX}-01"

# The shared sudoers drop-in grants the live medium password-less sudo, which
# the x86 installer replaces at install time. A flashed Pi image has no
# installer, so apply the same tightening here.
install -Dm0440 /dev/stdin "${ROOT_MNT}/etc/sudoers.d/vscodeos" <<'SUDOERS'
# VS Code OS: members of wheel may use sudo with their own password.
%wheel ALL=(ALL:ALL) ALL
SUDOERS

# --------------------------------------------------------------------------
# accounts, locale, editor
# --------------------------------------------------------------------------

# Tell the on-screen welcome file how this particular machine came to be, while
# it is still /etc/skel - useradd copies it into the new home directory below.
cat >> "${ROOT_MNT}/etc/skel/Projects/README.md" <<'WELCOME'

---

## On a Raspberry Pi

This machine was flashed from a VS Code OS Pi image, so it is already the
installed system - there is nothing to install. The root filesystem was
expanded to fill your card the first time it booted.

The default login is **vscodeos / vscodeos**. Change it now:

```bash
passwd
```

Wi-Fi: run `nmtui` in the terminal. A 4 GB Pi 4 or a Pi 5 gives the best
experience; on 1-2 GB boards expect the editor to lean on zram swap.
WELCOME

msg "creating the kiosk account"
# Arch Linux ARM ships a default 'alarm' user on uid 1000; replace it.
in_chroot "userdel -r alarm 2>/dev/null || true"
in_chroot "useradd --create-home --uid 1000 --shell /usr/bin/bash --comment 'VS Code OS' vscodeos"
# Add the supplementary groups that exist, rather than failing the whole build
# if one of them is not present in this Arch Linux ARM snapshot.
in_chroot "for g in wheel audio video storage optical network input lp rfkill; do
               getent group \"\${g}\" >/dev/null && usermod -aG \"\${g}\" vscodeos
           done; true"
in_chroot "echo 'vscodeos:vscodeos' | chpasswd"
in_chroot "passwd --lock root"

msg "generating locales"
in_chroot "locale-gen"

msg "staging Visual Studio Code"
# The arm64 build unpacks to roughly 600 MiB; ask for a little more than that.
require_image_space 800 "unpacking Visual Studio Code"
"${REPO_ROOT}/scripts/fetch-vscode.sh" "${ROOT_MNT}" "${VSCODE_VERSION:-latest}" arm64
msg "image root filesystem: $(free_mb "${ROOT_MNT}") MiB free after VS Code"

msg "finalising /home/vscodeos"
in_chroot "chown -R vscodeos:vscodeos /home/vscodeos"

# --------------------------------------------------------------------------
# identity and initramfs
# --------------------------------------------------------------------------

vscode_version="$(sed -n 's/^version=//p' "${ROOT_MNT}/usr/share/vscodeos/vscode-version")"
install -Dm0644 /dev/stdin "${ROOT_MNT}/etc/os-release" <<EOF
NAME="VS Code OS"
PRETTY_NAME="VS Code OS ${BUILD_VERSION} (Raspberry Pi)"
ID=vscodeos
ID_LIKE=arch
BUILD_ID=${BUILD_VERSION}
VERSION_ID=${BUILD_VERSION}
ANSI_COLOR="38;2;0;122;204"
HOME_URL="https://github.com/danisss9/VsCodeOS"
SUPPORT_URL="https://github.com/danisss9/VsCodeOS/issues"
BUG_REPORT_URL="https://github.com/danisss9/VsCodeOS/issues"
LOGO=visual-studio-code
EOF
install -Dm0644 /dev/stdin "${ROOT_MNT}/usr/share/vscodeos/build-info" <<EOF
build_version=${BUILD_VERSION}
target=raspberrypi-aarch64
vscode_version=${vscode_version}
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
git_commit=$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)
EOF

msg "building the initramfs"
in_chroot "mkinitcpio -P"

# The firmware loads these by name from the FAT partition (see config.txt). If
# Arch Linux ARM ever renames them the image would boot to a black screen, so
# fail here instead.
for f in kernel8.img initramfs-linux.img; do
    [[ -s "${ROOT_MNT}/boot/${f}" ]] ||
        die "/boot/${f} is missing from the image - it would not boot"
done
[[ -s "${ROOT_MNT}/boot/start4.elf" || -s "${ROOT_MNT}/boot/start.elf" ]] ||
    die "Raspberry Pi firmware (start*.elf) is missing from /boot"

# Nothing chroots into the image after this point, so anything still running in
# there is a leftover daemon, and every mount below is one it can pin.
msg "stopping anything still running inside the image"
stop_chroot_processes ||
    msg "  something inside the image will not exit - its mounts are detached below"

msg "detaching the package cache"
# The downloads went to the work directory, so there is nothing to delete here:
# unmounting simply leaves the image's own (empty) cache directory in place.
umount_tree "${ROOT_MNT}/var/cache/pacman/pkg" || {
    mount_holders "${ROOT_MNT}/var/cache/pacman/pkg" >&2
    die "could not unmount the package cache"
}
rm -f "${ROOT_MNT}/etc/resolv.conf"

# Zeroing the free space costs a few minutes but shrinks the compressed
# artifact dramatically, which matters against GitHub's 2 GiB asset limit.
msg "zeroing free space to help compression"
dd if=/dev/zero of="${ROOT_MNT}/ZEROFILL" bs=4M status=none 2>/dev/null || true
sync
rm -f "${ROOT_MNT}/ZEROFILL"
sync

# --------------------------------------------------------------------------
# finish
# --------------------------------------------------------------------------

msg "unmounting"
# /dev, /proc, /sys, /run and the package cache are the host's own filesystems,
# borrowed for the chroot; none of them is part of the image. If one is still
# busy, detaching it lazily costs the build nothing and gets it out of the way
# of the two mounts that do carry data.
for m in dev/pts dev proc sys run var/cache/pacman/pkg; do
    umount_tree "${ROOT_MNT}/${m}" && continue
    mountpoint -q "${ROOT_MNT}/${m}" || continue
    msg "  ${m} is still busy - detaching it lazily (it holds no image data)"
    mount_holders "${ROOT_MNT}/${m}"
    umount -Rl "${ROOT_MNT}/${m}" || die "could not detach ${ROOT_MNT}/${m}"
done

# These two are the image. A lazy unmount here would let the loop device go
# while writes were still in flight, so they have to come down properly - if one
# of them is pinned, that is a real failure and the artifact is not trustworthy.
sync
for m in boot ""; do
    umount_tree "${ROOT_MNT}/${m}" || {
        mount_holders "${ROOT_MNT}/${m}" >&2
        die "could not unmount ${ROOT_MNT}/${m}"
    }
done
losetup -d "${LOOP}"
LOOP=""
ROOT_MNT=""

msg "compressing (this takes a while)"
raw_size="$(du -h "${IMAGE}" | cut -f1)"
target="${OUT_DIR}/VSCodeOS-${BUILD_VERSION}-aarch64-rpi.img.xz"
rm -f "${target}"
xz --compress --threads=0 -9 --stdout "${IMAGE}" > "${target}"
rm -f "${IMAGE}"
( cd "${OUT_DIR}" && sha256sum "${target##*/}" > "${target##*/}.sha256" )

msg "done"
printf '    %s\n    %s compressed (from %s raw)\n' \
    "${target}" "$(du -h "${target}" | cut -f1)" "${raw_size}"
