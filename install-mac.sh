#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Docyrus Open IDE"
RELEASE_TAG="v0.1.6"
ARCHIVE_NAME="Docyrus-Open-IDE-v0.1.6-macos-arm64.zip"
EXPECTED_SHA256="a476660cd440cfadba983fe619c85c029c83992744e500afdbab4f58d60cb8f6"
INSTALL_PATH="/Applications/${APP_NAME}.app"
DOWNLOAD_URL="https://github.com/Docyrus/docyrus-open-ide/releases/download/${RELEASE_TAG}/${ARCHIVE_NAME}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Docyrus Open IDE currently supports macOS only." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This preview installer currently supports Apple Silicon Macs only." >&2
  exit 1
fi

for command in curl ditto pgrep shasum xattr open; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command not found: ${command}" >&2
    exit 1
  fi
done

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT

echo "Downloading ${APP_NAME}..."
curl -fL --retry 3 -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' --progress-bar "${DOWNLOAD_URL}" -o "${TEMP_DIR}/${ARCHIVE_NAME}"

if ! printf '%s  %s\n' "${EXPECTED_SHA256}" "${TEMP_DIR}/${ARCHIVE_NAME}" | shasum -a 256 -c - >/dev/null; then
  echo "Downloaded archive checksum did not match ${RELEASE_TAG}; refusing to install." >&2
  exit 1
fi

ditto -x -k "${TEMP_DIR}/${ARCHIVE_NAME}" "${TEMP_DIR}/expanded"

SOURCE_APP="${TEMP_DIR}/expanded/${APP_NAME}.app"
if [[ ! -d "${SOURCE_APP}" ]]; then
  echo "The release archive did not contain ${APP_NAME}.app." >&2
  exit 1
fi

if pgrep -x "docyrus-open-ide" >/dev/null 2>&1; then
  echo "Quit ${APP_NAME}, then run this installer again." >&2
  exit 1
fi

install_app() {
  rm -rf "${INSTALL_PATH}"
  ditto "${SOURCE_APP}" "${INSTALL_PATH}"
  xattr -dr com.apple.quarantine "${INSTALL_PATH}" 2>/dev/null || true
}

if [[ -w /Applications ]]; then
  install_app
else
  echo "Administrator access is required to install in /Applications."
  sudo bash -c "rm -rf '${INSTALL_PATH}' && ditto '${SOURCE_APP}' '${INSTALL_PATH}' && xattr -dr com.apple.quarantine '${INSTALL_PATH}' 2>/dev/null || true"
fi

echo "Installed ${APP_NAME} in /Applications."
open "${INSTALL_PATH}"
