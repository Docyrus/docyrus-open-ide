#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Docyrus Open IDE"
ARCHIVE_NAME="Docyrus-Open-IDE-macos-arm64.zip"
INSTALL_PATH="/Applications/${APP_NAME}.app"
DOWNLOAD_URL="https://github.com/Docyrus/docyrus-open-ide/releases/latest/download/${ARCHIVE_NAME}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Docyrus Open IDE currently supports macOS only." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This preview installer currently supports Apple Silicon Macs only." >&2
  exit 1
fi

for command in curl ditto xattr open; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command not found: ${command}" >&2
    exit 1
  fi
done

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT

echo "Downloading ${APP_NAME}..."
curl -fL --retry 3 --progress-bar "${DOWNLOAD_URL}" -o "${TEMP_DIR}/${ARCHIVE_NAME}"
ditto -x -k "${TEMP_DIR}/${ARCHIVE_NAME}" "${TEMP_DIR}/expanded"

SOURCE_APP="${TEMP_DIR}/expanded/${APP_NAME}.app"
if [[ ! -d "${SOURCE_APP}" ]]; then
  echo "The release archive did not contain ${APP_NAME}.app." >&2
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
