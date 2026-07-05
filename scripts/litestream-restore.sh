#!/usr/bin/env bash
# Restore the SQLite DB from the Litestream R2 replica (Litestream 0.5.x).
# Usage: bash scripts/litestream-restore.sh [output-path]
#
# Required env vars:
#   LITESTREAM_S3_BUCKET, LITESTREAM_S3_ENDPOINT,
#   LITESTREAM_S3_ACCESS_KEY_ID, LITESTREAM_S3_SECRET_ACCESS_KEY
# Optional:
#   LITESTREAM_S3_REGION  (default: auto)
set -euo pipefail

OUTPUT="${1:-/data/prod.db}"
CONFIG="${LITESTREAM_CONFIG:-./litestream.yml}"
DB="/data/prod.db"
LITESTREAM_BIN="./bin/litestream"

# Fall back to .env if the creds are not already exported.
if [[ -z "${LITESTREAM_S3_BUCKET:-}" && -f .env ]]; then
  set -a
  eval "$(grep -E '^LITESTREAM_' .env)"
  set +a
fi

# Fall back to system litestream if ./bin/litestream doesn't exist
if [ ! -f "$LITESTREAM_BIN" ]; then
  if command -v litestream &> /dev/null; then
    LITESTREAM_BIN="litestream"
  else
    echo "ERR: litestream binary not found at $LITESTREAM_BIN or in PATH"
    exit 1
  fi
fi

: "${LITESTREAM_S3_BUCKET?Required: LITESTREAM_S3_BUCKET}"
: "${LITESTREAM_S3_ACCESS_KEY_ID?Required: LITESTREAM_S3_ACCESS_KEY_ID}"
: "${LITESTREAM_S3_SECRET_ACCESS_KEY?Required: LITESTREAM_S3_SECRET_ACCESS_KEY}"

echo "Restoring latest backup to: $OUTPUT"
# 0.5.x: single replica, no -replica flag. Give the configured DB path; -o sets output.
"$LITESTREAM_BIN" restore -config "$CONFIG" -if-replica-exists -o "$OUTPUT" "$DB"

echo "Restore complete: $OUTPUT"
