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
IMAGE_SIZE_MB="${IMAGE_SIZE_MB:-5120}"
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

cleanup() {
    local rc=$?
    set +e
    if [[ -n "${ROOT_MNT}" && -d "${ROOT_MNT}" ]]; then
        local m
        for m in dev/pts dev proc sys run boot ""; do
            mountpoint -q "${ROOT_MNT}/${m}" && umount -R "${ROOT_MNT}/${m}"
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

rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}" "${OUT_DIR}"
readonly TARBALL="${WORK_DIR}/alarm-rootfs.tar.gz"

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
mkfs.ext4 -q -F -L "${ROOT_LABEL}" "${LOOP}p2"

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

mount --bind /dev  "${ROOT_MNT}/dev"
mount --bind /dev/pts "${ROOT_MNT}/dev/pts"
mount -t proc proc "${ROOT_MNT}/proc"
mount -t sysfs sys "${ROOT_MNT}/sys"
mount -t tmpfs tmpfs "${ROOT_MNT}/run"
cp -f /etc/resolv.conf "${ROOT_MNT}/etc/resolv.conf"

in_chroot() { chroot "${ROOT_MNT}" /bin/bash -euo pipefail -c "$*"; }

msg "initialising the package keyring"
in_chroot "pacman-key --init && pacman-key --populate archlinuxarm"

msg "updating the base system"
in_chroot "pacman -Syu --noconfirm"

msg "installing the VS Code OS package set"
mapfile -t packages < <(grep -vE '^[[:space:]]*(#|$)' "${RPI_DIR}/packages.aarch64")
in_chroot "pacman -S --noconfirm --needed ${packages[*]}"

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
"${REPO_ROOT}/scripts/fetch-vscode.sh" "${ROOT_MNT}" "${VSCODE_VERSION:-latest}" arm64

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

msg "clearing the package cache"
in_chroot "pacman -Scc --noconfirm >/dev/null 2>&1 || true"
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
for m in dev/pts dev proc sys run boot ""; do
    if mountpoint -q "${ROOT_MNT}/${m}"; then
        umount -R "${ROOT_MNT}/${m}" || die "could not unmount ${ROOT_MNT}/${m}"
    fi
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
