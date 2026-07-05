#!/usr/bin/env bash
# Downloads and extracts the Litestream binary to ./bin/litestream
set -euo pipefail

LITESTREAM_VERSION="v0.5.12"

# Detect OS
OS_UNAME="$(uname -s | tr '[:upper:]' '[:lower:]')"
if [ "$OS_UNAME" = "darwin" ]; then
  PLATFORM="darwin"
else
  PLATFORM="linux"
fi

# Detect Arch
ARCH_UNAME="$(uname -m)"
if [ "$ARCH_UNAME" = "x86_64" ]; then
  ARCH="amd64"
elif [ "$ARCH_UNAME" = "arm64" ] || [ "$ARCH_UNAME" = "aarch64" ]; then
  ARCH="arm64"
else
  ARCH="amd64" # Default fallback
fi

TARBALL="litestream-${LITESTREAM_VERSION}-${PLATFORM}-${ARCH}.tar.gz"
URL="https://github.com/benbjohnson/litestream/releases/download/${LITESTREAM_VERSION}/${TARBALL}"

mkdir -p bin
echo "Downloading Litestream ${LITESTREAM_VERSION} for ${PLATFORM}/${ARCH} from ${URL}..."
curl -L -s -o "${TARBALL}" "${URL}"

echo "Extracting Litestream binary to ./bin/litestream..."
tar -xzf "${TARBALL}" -C bin/
rm "${TARBALL}"

chmod +x bin/litestream
echo "Litestream installed successfully at ./bin/litestream"
