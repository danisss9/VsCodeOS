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

(( EUID == 0 )) || die "this build must run as root (mkarchiso needs it)"
command -v mkarchiso >/dev/null || die "mkarchiso not found - install the 'archiso' package"

readonly RELENG="/usr/share/archiso/configs/releng"
[[ -f "${RELENG}/grub/grub.cfg" ]] ||
    die "${RELENG}/grub/grub.cfg is missing - this build needs archiso >= 75 (GRUB-based UEFI boot)"

# --------------------------------------------------------------------------
# assemble a throwaway copy of the profile
# --------------------------------------------------------------------------

readonly PROFILE="${WORK_DIR}/profile"
msg "staging profile in ${PROFILE}"
rm -rf "${WORK_DIR}"
mkdir -p "${PROFILE}" "${OUT_DIR}"
cp -a "${PROFILE_SRC}/." "${PROFILE}/"

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
"${REPO_ROOT}/scripts/fetch-vscode.sh" "${PROFILE}/airootfs" "${VSCODE_VERSION:-latest}"

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

msg "done"
printf '    %s\n    %s\n' "${target}" "$(du -h "${target}" | cut -f1)"
