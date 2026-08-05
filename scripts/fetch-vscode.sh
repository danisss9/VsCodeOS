#!/usr/bin/env bash
# Download the official Visual Studio Code build and stage it inside the
# archiso profile, so the ISO ships a ready-to-run editor with no network
# access required at install time.
#
# Usage: scripts/fetch-vscode.sh <rootfs-dir> [version] [arch]
#
#   version defaults to "latest"; pin an exact build (e.g. 1.98.2) by passing
#   it here or by exporting VSCODE_VERSION.
#   arch is a Microsoft download slug - "x64" or "arm64" - and defaults to
#   whatever the build host is.

set -Eeuo pipefail

readonly AIROOTFS="${1:?usage: fetch-vscode.sh <rootfs-dir> [version] [arch]}"
readonly VERSION="${2:-${VSCODE_VERSION:-latest}}"
readonly CHANNEL="${VSCODE_CHANNEL:-stable}"

case "${3:-${VSCODE_ARCH:-$(uname -m)}}" in
    x64|x86_64|amd64)  readonly ARCH="x64" ;;
    arm64|aarch64)     readonly ARCH="arm64" ;;
    *) echo "unsupported VS Code architecture: ${3:-$(uname -m)}" >&2; exit 1 ;;
esac

readonly URL="https://update.code.visualstudio.com/${VERSION}/linux-${ARCH}/${CHANNEL}"
readonly PREFIX="${AIROOTFS}/opt/visual-studio-code"

[[ -d "${AIROOTFS}" ]] || { echo "no such directory: ${AIROOTFS}" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

echo "==> fetching Visual Studio Code (${VERSION}/linux-${ARCH}/${CHANNEL})"
curl --fail --location --retry 5 --retry-delay 3 --retry-connrefused \
    --silent --show-error -o "${tmp}/code.tar.gz" "${URL}"

echo "==> sha256: $(sha256sum "${tmp}/code.tar.gz" | cut -d' ' -f1)"

rm -rf "${PREFIX}"

# Unpacking into a full filesystem gets you one "No space left on device" per
# file - hundreds of lines that never mention the destination or how short it
# was. The tree comes out at roughly three times the archive; ask for four.
# Measured after the old tree is gone, so a rebuild counts the room it frees.
archive_mb=$(( $(stat -c %s "${tmp}/code.tar.gz") / 1048576 ))
needed_mb=$(( archive_mb * 4 ))
available_mb="$(df -B1M --output=avail "${AIROOTFS}" | awk 'NR == 2 { print $1 }')"
if (( available_mb < needed_mb )); then
    echo "not enough room in ${AIROOTFS}: unpacking VS Code needs about ${needed_mb} MiB, ${available_mb} MiB free" >&2
    exit 1
fi

mkdir -p "${PREFIX}"
tar -xzf "${tmp}/code.tar.gz" -C "${PREFIX}" --strip-components=1

[[ -x "${PREFIX}/code" ]] || { echo "unpacked archive has no code binary" >&2; exit 1; }

version="$(grep -oP '"version"\s*:\s*"\K[^"]+' "${PREFIX}/resources/app/package.json" | head -1)"
commit="$(grep -oP '"commit"\s*:\s*"\K[^"]+' "${PREFIX}/resources/app/product.json" | head -1)"

# Icon for the desktop entry and anything else that looks it up by name.
install -Dm0644 \
    "${PREFIX}/resources/app/resources/linux/code.png" \
    "${AIROOTFS}/usr/share/pixmaps/visual-studio-code.png" 2>/dev/null || true

# Record what went in, so the running system can report its own provenance.
install -Dm0644 /dev/stdin "${AIROOTFS}/usr/share/vscodeos/vscode-version" <<EOF
version=${version}
commit=${commit}
arch=${ARCH}
channel=${CHANNEL}
source=${URL}
fetched=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

chown -R 0:0 "${PREFIX}" 2>/dev/null || true
# Electron needs either unprivileged user namespaces or a SUID helper to start
# its sandbox. Setting the SUID bit (what distro packages do) makes the editor
# start on hardened kernels too, instead of dying with a sandbox error.
if [[ -f "${PREFIX}/chrome-sandbox" ]]; then
    chown 0:0 "${PREFIX}/chrome-sandbox"
    chmod 4755 "${PREFIX}/chrome-sandbox"
fi
echo "==> staged Visual Studio Code ${version} (${commit:0:8}) in ${PREFIX}"
