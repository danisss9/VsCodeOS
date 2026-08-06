#!/usr/bin/env bash
# Print the versions of the packages worth naming from a build manifest.
#
# Arch is a rolling release, so an image ships whatever the mirrors held while
# it was being built - there is no version to read off the profile. Writing the
# interesting ones into the build log (and the CI job summary) is what makes
# "this release is current" something you can check afterwards rather than
# assume.
#
# Usage: scripts/pkg-versions.sh <manifest> [--markdown]
#
#   <manifest> holds one 'name version' pair per line, the format `pacman -Q`
#   prints. Both build scripts leave one next to the image they produce.

set -Eeuo pipefail

MANIFEST="${1:?usage: pkg-versions.sh <manifest> [--markdown]}"
FORMAT="plain"
[[ "${2:-}" == "--markdown" ]] && FORMAT="markdown"

[[ -r "${MANIFEST}" ]] || { echo "no such manifest: ${MANIFEST}" >&2; exit 1; }

# The kernel, the toolchain and the graphics stack: the handful anyone checking
# whether the image is current would look up. Names that the image does not
# carry (linux-rpi on x86, docker on the Pi) are simply skipped.
readonly INTERESTING=(
    linux linux-rpi linux-firmware-intel systemd glibc
    mesa xorg-server openbox
    git nodejs npm python gcc docker
    openssl gnupg
)

[[ "${FORMAT}" == "markdown" ]] && printf '| Package | Version |\n| --- | --- |\n'

for pkg in "${INTERESTING[@]}"; do
    version="$(awk -v p="${pkg}" '$1 == p { print $2; exit }' "${MANIFEST}")"
    [[ -n "${version}" ]] || continue
    if [[ "${FORMAT}" == "markdown" ]]; then
        printf '| `%s` | %s |\n' "${pkg}" "${version}"
    else
        printf '    %-22s %s\n' "${pkg}" "${version}"
    fi
done
