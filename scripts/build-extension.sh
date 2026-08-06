#!/usr/bin/env bash
# Build VsCodeOsCore and lay out the tree that ships inside both images.
#
# The output is the exact directory that goes to
# /usr/share/vscodeos/extensions/vscodeos-core, from where
# vscodeos-install-extensions copies it into VS Code's built-in extensions
# folder. Architecture-neutral JavaScript, so CI builds it once and both image
# jobs consume the same artifact.
#
# Usage: scripts/build-extension.sh [-o out-dir]
#
# Environment:
#   VSCODEOS_EXTENSION_PREBUILT  a directory already containing vscodeos-core/;
#                                it is used as-is and no Node is needed.
#   VSCODEOS_SKIP_EXTENSION=1    skip the build entirely (OS-only iteration).

set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly SRC_DIR="${REPO_ROOT}/extension"
readonly NAME="vscodeos-core"

OUT_DIR="${REPO_ROOT}/out/extension"

msg() { printf '\e[38;5;39m==>\e[0m %s\n' "$*"; }
die() { printf '\e[38;5;203merror\e[0m %s\n' "$*" >&2; exit 1; }

while (( $# )); do
    case "$1" in
        -o|--out)  OUT_DIR="$2"; shift 2 ;;
        -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

OUT_DIR="$(readlink -m -- "${OUT_DIR}")"
readonly TARGET="${OUT_DIR}/${NAME}"

if [[ "${VSCODEOS_SKIP_EXTENSION:-0}" == "1" ]]; then
    msg "VSCODEOS_SKIP_EXTENSION=1 - the image will ship without the desktop shell"
    exit 0
fi

# --------------------------------------------------------------------------
# a prebuilt tree (the CI artifact) short-circuits everything
# --------------------------------------------------------------------------

if [[ -n "${VSCODEOS_EXTENSION_PREBUILT:-}" ]]; then
    prebuilt="$(readlink -m -- "${VSCODEOS_EXTENSION_PREBUILT}")"
    [[ -f "${prebuilt}/${NAME}/package.json" ]] ||
        die "VSCODEOS_EXTENSION_PREBUILT=${prebuilt} has no ${NAME}/package.json"
    [[ -f "${prebuilt}/${NAME}/dist/extension.js" ]] ||
        die "VSCODEOS_EXTENSION_PREBUILT=${prebuilt} has no ${NAME}/dist/extension.js"

    if [[ "${prebuilt}" != "${OUT_DIR}" ]]; then
        mkdir -p "${OUT_DIR}"
        rm -rf "${TARGET}"
        cp -aT "${prebuilt}/${NAME}" "${TARGET}"
    fi
    msg "using the prebuilt extension from ${prebuilt}"
    exit 0
fi

# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------

[[ -f "${SRC_DIR}/package.json" ]] || die "no extension sources at ${SRC_DIR}"

command -v node >/dev/null || die "node not found - install nodejs (or set VSCODEOS_EXTENSION_PREBUILT)"
command -v npm  >/dev/null || die "npm not found - install npm (or set VSCODEOS_EXTENSION_PREBUILT)"

# Rebuild only when something that feeds the bundle is newer than the bundle.
# `find -newer` over the inputs is enough here and keeps repeated image builds
# from paying for npm every time.
bundle="${SRC_DIR}/dist/extension.js"
needs_build=1
if [[ -f "${bundle}" ]]; then
    newer="$(find "${SRC_DIR}/src" "${SRC_DIR}/media/src" "${SRC_DIR}/media/css" \
                  "${SRC_DIR}/package.json" "${SRC_DIR}/esbuild.mjs" \
                  -newer "${bundle}" -print -quit 2>/dev/null || true)"
    [[ -z "${newer}" ]] && needs_build=0
fi

if (( needs_build )); then
    msg "building VsCodeOsCore ($(node --version))"
    if [[ -f "${SRC_DIR}/package-lock.json" ]]; then
        npm ci --prefix "${SRC_DIR}" --no-audit --no-fund
    else
        npm install --prefix "${SRC_DIR}" --no-audit --no-fund
    fi
    npm run --prefix "${SRC_DIR}" package
else
    msg "VsCodeOsCore is already up to date"
fi

[[ -f "${bundle}" ]] || die "the build produced no dist/extension.js"

# --------------------------------------------------------------------------
# lay out the shipped tree
# --------------------------------------------------------------------------

# Assembled by hand rather than by copying the source tree minus .vscodeignore:
# what goes into an image should be an explicit list, not a subtraction.
msg "staging ${TARGET}"
rm -rf "${TARGET}"
install -d -m 0755 "${TARGET}"

install -m 0644 "${SRC_DIR}/package.json" "${TARGET}/package.json"
[[ -f "${SRC_DIR}/README.md" ]] && install -m 0644 "${SRC_DIR}/README.md" "${TARGET}/README.md"
[[ -f "${REPO_ROOT}/LICENSE" ]] && install -m 0644 "${REPO_ROOT}/LICENSE" "${TARGET}/LICENSE"

install -d -m 0755 "${TARGET}/dist"
install -m 0644 "${SRC_DIR}"/dist/*.js "${TARGET}/dist/"

install -d -m 0755 "${TARGET}/media/dist" "${TARGET}/media/css" "${TARGET}/media/icons"
install -m 0644 "${SRC_DIR}"/media/dist/*.js "${TARGET}/media/dist/"
install -m 0644 "${SRC_DIR}"/media/css/*.css "${TARGET}/media/css/"
install -m 0644 "${SRC_DIR}"/media/icons/*.svg "${TARGET}/media/icons/"

version="$(node -p "require('${TARGET}/package.json').version")"
msg "VsCodeOsCore ${version} staged in ${TARGET} ($(du -sh "${TARGET}" | cut -f1))"
