#!/usr/bin/env bash
# Build-time download of a pinned Litestream release into ./bin/litestream.
#
# Litestream (https://litestream.io) continuously replicates the SQLite file
# on this app's Render disk to an S3-compatible bucket (Cloudflare R2). This
# script only fetches the binary; whether replication actually runs is
# controlled entirely by the LITESTREAM_S3_* env vars at runtime — see
# scripts/start-with-litestream.sh. Safe to run even when replication is
# never enabled; it just leaves an unused binary in ./bin.
#
# DEPLOY-SAFE: this runs in every build's buildCommand, but a download or
# checksum failure only WARNS and exits 0 (without installing) — it never
# fails the build. So a transient GitHub outage / rate-limit / removed asset
# cannot block an ordinary app deploy, even though the feature is off by
# default. If replication was configured, a failed fetch means bin/litestream
# is absent, so start-with-litestream.sh simply runs without replication that
# deploy and the next deploy re-attempts the fetch.
#
# Pinned version: v0.5.13 (newest 0.5.x at the time this script was written,
# verified against the GitHub Releases API: `api.github.com/repos/
# benbjohnson/litestream/releases`). Litestream 0.5.x uses the LTX file model
# and a single-replica-per-database config, matching litestream.yml here and
# the sibling Socratic.Trade app's docs/litestream.md this was adapted from.
#
# Release asset naming note: GitHub release assets for this project use
# "linux-x86_64", not "linux-amd64" (despite Go's GOARCH being amd64) — the
# 404 you'd get from the amd64-named URL is why this is called out here.
#
# Idempotent: if a binary is already present at ./bin/litestream and its
# sha256 matches the pin below, this exits immediately without re-downloading.
set -euo pipefail

LITESTREAM_VERSION="0.5.13"
LITESTREAM_OS="linux"
LITESTREAM_ARCH="x86_64"
LITESTREAM_ASSET="litestream-${LITESTREAM_VERSION}-${LITESTREAM_OS}-${LITESTREAM_ARCH}.tar.gz"
LITESTREAM_URL="https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${LITESTREAM_ASSET}"
# From that release's checksums.txt (sha256 of the .tar.gz asset itself, not
# the extracted binary). Re-verify at https://github.com/benbjohnson/litestream/releases/tag/v0.5.13
LITESTREAM_SHA256="fc3420fea7d2f92d4d604aceeb0d7c63dc2c91f6ee5c1547cc05e25629e70f9f"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BIN_DIR="${REPO_ROOT}/bin"
BIN_PATH="${BIN_DIR}/litestream"

log() {
  echo "[fetch-litestream] $*"
}

sha256_of() {
  # macOS (shasum) and Linux (sha256sum) both show up in dev/CI vs. Render.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "ERROR: no sha256sum or shasum available to verify the download" >&2
    exit 1
  fi
}

# Idempotent skip: only trust an existing binary if it reports the exact
# version we pin — protects against a stale binary left over from a prior
# pin surviving a Render build-cache hit silently.
#
# Tradeoff (accepted): on this skip path we match the `version` string but do
# NOT re-verify the on-disk binary's sha256, so a build-cache hit does not
# re-check the checksum pin. Render's persistent build cache is a trusted
# boundary — anything that can tamper with a cached ./bin/litestream can
# tamper with the checked-out source too — and re-downloading the release on
# every build to re-verify would defeat the idempotency this skip exists for.
# The sha256 pin below is still enforced on every real download (cache miss,
# version bump, or first build), which is where a tampered/corrupt tarball
# would actually enter.
if [[ -x "${BIN_PATH}" ]]; then
  EXISTING_VERSION="$("${BIN_PATH}" version 2>&1 || true)"
  if [[ "${EXISTING_VERSION}" == *"${LITESTREAM_VERSION}"* ]]; then
    log "bin/litestream already present at v${LITESTREAM_VERSION} — skipping download."
    exit 0
  fi
  log "bin/litestream present but not v${LITESTREAM_VERSION} (found: ${EXISTING_VERSION}) — re-fetching."
fi

mkdir -p "${BIN_DIR}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

TARBALL="${TMP_DIR}/${LITESTREAM_ASSET}"

log "Downloading ${LITESTREAM_URL}"
if ! curl -fsSL --retry 3 --retry-connrefused -o "${TARBALL}" "${LITESTREAM_URL}"; then
  echo "[fetch-litestream] WARNING: failed to download ${LITESTREAM_URL}" >&2
  echo "[fetch-litestream] Check network access and that v${LITESTREAM_VERSION} still has a" >&2
  echo "[fetch-litestream] ${LITESTREAM_ASSET} asset at https://github.com/benbjohnson/litestream/releases" >&2
  echo "[fetch-litestream] Continuing WITHOUT installing litestream so a transient GitHub" >&2
  echo "[fetch-litestream] outage can't block this deploy. Replication stays OFF this deploy" >&2
  echo "[fetch-litestream] (start-with-litestream.sh only replicates when bin/litestream exists);" >&2
  echo "[fetch-litestream] the next deploy re-attempts the fetch." >&2
  exit 0
fi

ACTUAL_SHA256="$(sha256_of "${TARBALL}")"
if [[ "${ACTUAL_SHA256}" != "${LITESTREAM_SHA256}" ]]; then
  echo "[fetch-litestream] WARNING: sha256 mismatch for ${LITESTREAM_ASSET}" >&2
  echo "[fetch-litestream]   expected: ${LITESTREAM_SHA256}" >&2
  echo "[fetch-litestream]   actual:   ${ACTUAL_SHA256}" >&2
  echo "[fetch-litestream] Refusing to install a binary that doesn't match the pinned checksum." >&2
  echo "[fetch-litestream] Continuing WITHOUT installing it (replication stays OFF this deploy)" >&2
  echo "[fetch-litestream] rather than blocking the deploy or shipping an unverified binary." >&2
  exit 0
fi
log "sha256 verified: ${ACTUAL_SHA256}"

tar -xzf "${TARBALL}" -C "${TMP_DIR}" litestream
mv "${TMP_DIR}/litestream" "${BIN_PATH}"
chmod +x "${BIN_PATH}"

log "Installed bin/litestream $("${BIN_PATH}" version 2>&1 || echo "v${LITESTREAM_VERSION}")"
