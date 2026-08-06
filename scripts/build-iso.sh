#!/usr/bin/env bash
# Build the VS Code OS installation ISO.
#
# Must run as root on Arch Linux (or inside an Arch container) with archiso
# installed. The GitHub Actions workflow does exactly that; see the README for
# the one-liner to reproduce a build locally.
#
# Usage: sudo scripts/build-iso.sh [-o out-dir] [-w work-dir] [-v version]

set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly PROFILE_SRC="${REPO_ROOT}/archiso"
readonly ROOTFS_COMMON="${REPO_ROOT}/rootfs-common"

OUT_DIR="${REPO_ROOT}/out"
WORK_DIR="${REPO_ROOT}/work"
BUILD_VERSION="${ISO_VERSION:-$(date +%Y.%m.%d)}"

msg()  { printf '\e[38;5;39m==>\e[0m %s\n' "$*"; }
die()  { printf '\e[38;5;203merror\e[0m %s\n' "$*" >&2; exit 1; }

while (( $# )); do
    case "$1" in
        -o|--out)     OUT_DIR="$2"; shift 2 ;;
        -w|--work)    WORK_DIR="$2"; shift 2 ;;
        -v|--version) BUILD_VERSION="$2"; shift 2 ;;
        -h|--help)    sed -n '2,9p' "$0"; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

OUT_DIR="$(readlink -m -- "${OUT_DIR}")"
WORK_DIR="$(readlink -m -- "${WORK_DIR}")"

(( EUID == 0 )) || die "this build must run as root (mkarchiso needs it)"
command -v mkarchiso >/dev/null || die "mkarchiso not found - install the 'archiso' package"

readonly RELENG="/usr/share/archiso/configs/releng"
[[ -f "${RELENG}/grub/grub.cfg" ]] ||
    die "${RELENG}/grub/grub.cfg is missing - this build needs archiso >= 86 (GRUB-based UEFI boot)"

# The profile asks for the 'uefi.grub' boot mode, which archiso 86 introduced in
# place of the uefi-{ia32,x64}.grub.{esp,eltorito} quartet.
grep -q '_validate_requirements_bootmode_uefi\.grub()' "$(command -v mkarchiso)" ||
    die "this mkarchiso does not know the 'uefi.grub' boot mode - update 'archiso' to 86 or newer"

# GRUB is only an optional dependency of archiso, so a host with mkarchiso
# cannot necessarily build the UEFI boot modes. Checking here fails the build in
# seconds instead of after the profile has been staged and VS Code downloaded.
command -v grub-mkstandalone >/dev/null ||
    die "grub-mkstandalone not found - install the 'grub' package (archiso needs it for UEFI boot)"

# --------------------------------------------------------------------------
# assemble a throwaway copy of the profile
# --------------------------------------------------------------------------

readonly PROFILE="${WORK_DIR}/profile"
msg "staging profile in ${PROFILE}"

# An aborted earlier run can leave mkarchiso's bind mounts behind; drop them
# before deleting anything so rm never recurses into a mounted filesystem.
if [[ -d "${WORK_DIR}" ]]; then
    while read -r mp; do
        [[ -n "${mp}" ]] || continue
        umount -R "${mp}" 2>/dev/null || umount -Rl "${mp}" 2>/dev/null || true
    done < <(findmnt -rno TARGET | awk -v d="${WORK_DIR}/" 'index($0, d) == 1' | sort -r)
fi

# The work directory is frequently a mount point rather than a plain directory -
# the CI job hands the build a volume on the roomy ephemeral disk - and removing
# a mount point fails with EBUSY, so empty it instead of deleting it.
mkdir -p "${WORK_DIR}" "${OUT_DIR}"
find "${WORK_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
mkdir -p "${PROFILE}"
cp -a "${PROFILE_SRC}/." "${PROFILE}/"

# The kiosk itself is architecture-neutral and shared with the Raspberry Pi
# image; the profile's own airootfs holds only the x86/live-medium extras.
install -d -m 0755 "${PROFILE}/airootfs"
cp -a "${ROOTFS_COMMON}/." "${PROFILE}/airootfs/"

# Boot menus come from the archiso release we are building against, so they
# always match the tooling's expectations; only the branding is ours.
msg "importing boot loader configuration from archiso ${RELENG##*/}"
cp -a "${RELENG}/syslinux" "${RELENG}/grub" "${PROFILE}/"
if [[ -d "${RELENG}/efiboot" ]]; then cp -a "${RELENG}/efiboot" "${PROFILE}/"; fi

find "${PROFILE}"/{syslinux,grub,efiboot} -type f \( -name '*.cfg' -o -name '*.conf' \) -print0 2>/dev/null |
    xargs -0 --no-run-if-empty sed -i \
        -e 's/Arch Linux install medium/VS Code OS/g' \
        -e 's/Arch Linux/VS Code OS/g' \
        -e 's/Arch menu/VS Code OS menu/g'

# --------------------------------------------------------------------------
# stage Visual Studio Code and the kiosk home directory
# --------------------------------------------------------------------------

msg "staging Visual Studio Code"
"${REPO_ROOT}/scripts/fetch-vscode.sh" "${PROFILE}/airootfs" "${VSCODE_VERSION:-latest}" x64

# The live user's home is /etc/skel, materialised: mkarchiso does not run
# useradd, so the account's dotfiles have to exist in the image already.
msg "materialising /home/vscodeos from /etc/skel"
install -d -m 0755 "${PROFILE}/airootfs/home"
cp -a "${PROFILE}/airootfs/etc/skel" "${PROFILE}/airootfs/home/vscodeos"
chown -R 1000:1000 "${PROFILE}/airootfs/home/vscodeos"
chmod 0750 "${PROFILE}/airootfs/home/vscodeos"

# Record the build so the running system can identify itself.
vscode_version="$(sed -n 's/^version=//p' "${PROFILE}/airootfs/usr/share/vscodeos/vscode-version")"
install -Dm0644 /dev/stdin "${PROFILE}/airootfs/etc/os-release" <<EOF
NAME="VS Code OS"
PRETTY_NAME="VS Code OS ${BUILD_VERSION}"
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
install -Dm0644 /dev/stdin "${PROFILE}/airootfs/usr/share/vscodeos/build-info" <<EOF
build_version=${BUILD_VERSION}
vscode_version=${vscode_version}
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
git_commit=$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)
EOF

# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------

msg "building ISO ${BUILD_VERSION} (VS Code ${vscode_version})"
export ISO_VERSION="${BUILD_VERSION}"
mkarchiso -v -w "${WORK_DIR}/mkarchiso" -o "${OUT_DIR}" "${PROFILE}"

# --------------------------------------------------------------------------
# publish artefacts
# --------------------------------------------------------------------------

iso="$(find "${OUT_DIR}" -maxdepth 1 -name '*.iso' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
[[ -n "${iso}" ]] || die "mkarchiso produced no ISO"

target="${OUT_DIR}/VSCodeOS-${BUILD_VERSION}-x86_64.iso"
if [[ "${iso}" != "${target}" ]]; then mv -- "${iso}" "${target}"; fi

( cd "${OUT_DIR}" && sha256sum "${target##*/}" > "${target##*/}.sha256" )

# --------------------------------------------------------------------------
# package manifest
# --------------------------------------------------------------------------

# Nothing in the profile pins a version - pacstrap installs whatever the
# mirrors were serving during this run - so the only record of what shipped is
# the one written here, in the 'name version' form `pacman -Q` prints. The ISO
# already went out above, so a manifest that cannot be produced is a missing
# nicety rather than a failed build: none of this is allowed to be fatal.
manifest="${OUT_DIR}/VSCodeOS-${BUILD_VERSION}-x86_64.packages.txt"
rm -f "${manifest}"

# The image's own package database is the authority on what it contains.
pkgdb="$(find "${WORK_DIR}" -type d -path '*/airootfs/var/lib/pacman' -print -quit)"
if [[ -n "${pkgdb}" ]]; then
    pacman -Q --dbpath "${pkgdb}" 2>/dev/null | sort -u > "${manifest}" || true
fi

# Failing that, the list mkarchiso puts on the medium as /arch/pkglist.*.txt,
# whose lines read 'repo/name-pkgver-pkgrel'. Neither a pkgver nor a pkgrel may
# contain a hyphen, so the name is everything before the last two
# dash-separated fields - which is the only way to split it, since plenty of
# names (linux-firmware-intel) contain hyphens themselves.
if [[ ! -s "${manifest}" ]]; then
    pkglist="$(find "${WORK_DIR}" -type f -name 'pkglist.*.txt' -print -quit)"
    if [[ -n "${pkglist}" ]]; then
        sed 's|^[^/]*/||' "${pkglist}" | awk '
            {
                n = split($0, f, "-")
                if (n < 3) { print $0; next }
                version = f[n - 1] "-" f[n]
                print substr($0, 1, length($0) - length(version) - 1), version
            }' | sort -u > "${manifest}" || true
    fi
fi

if [[ ! -s "${manifest}" ]]; then
    rm -f "${manifest}"
    msg "warning: no package database or list left in ${WORK_DIR} - no manifest written"
fi

msg "done"
printf '    %s\n    %s\n' "${target}" "$(du -h "${target}" | cut -f1)"
if [[ -s "${manifest}" ]]; then
    printf '    %s package versions shipped\n' "$(wc -l < "${manifest}")"
    "${REPO_ROOT}/scripts/pkg-versions.sh" "${manifest}"
fi
