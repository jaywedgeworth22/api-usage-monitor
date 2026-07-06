#!/usr/bin/env bash
# Manual disaster-recovery restore of the api-usage-monitor SQLite DB from
# its Litestream R2 replica (Litestream 0.5.x). Run this from Render's Shell
# tab for the api-usage-monitor web service (the R2 creds and the /data disk
# are both only reachable from there — this cannot usefully run locally
# unless you export the same LITESTREAM_S3_* creds and just want a local
# copy of the replica for inspection).
#
# Usage: bash scripts/litestream-restore.sh [output-path]
#   output-path defaults to /data/prod.db.restored — NEVER the live
#   /data/prod.db path, so a bad restore can't clobber the running database
#   before you've verified it.
#
# Required env vars (set in Render's Environment tab):
#   LITESTREAM_S3_BUCKET, LITESTREAM_S3_ENDPOINT,
#   LITESTREAM_S3_ACCESS_KEY_ID, LITESTREAM_S3_SECRET_ACCESS_KEY
# Optional:
#   LITESTREAM_S3_REGION  (default: auto, for Cloudflare R2)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LITESTREAM_BIN="${REPO_ROOT}/bin/litestream"
CONFIG="${LITESTREAM_CONFIG:-${REPO_ROOT}/litestream.yml}"
LIVE_DB="/data/prod.db"
OUTPUT="${1:-/data/prod.db.restored}"

: "${LITESTREAM_S3_BUCKET?Required: LITESTREAM_S3_BUCKET}"
: "${LITESTREAM_S3_ENDPOINT?Required: LITESTREAM_S3_ENDPOINT}"
: "${LITESTREAM_S3_ACCESS_KEY_ID?Required: LITESTREAM_S3_ACCESS_KEY_ID}"
: "${LITESTREAM_S3_SECRET_ACCESS_KEY?Required: LITESTREAM_S3_SECRET_ACCESS_KEY}"

if [[ ! -x "${LITESTREAM_BIN}" ]]; then
  echo "ERROR: ${LITESTREAM_BIN} not found or not executable." >&2
  echo "It's installed by scripts/fetch-litestream.sh during the Render build -" >&2
  echo "if it's missing, the last deploy likely ran without LITESTREAM_S3_* set." >&2
  exit 1
fi

echo "Restoring latest replica to: ${OUTPUT}"
# 0.5.x: single replica, no -replica flag. Give the configured DB path; -o sets output.
"${LITESTREAM_BIN}" restore -config "${CONFIG}" -o "${OUTPUT}" "${LIVE_DB}"

echo ""
echo "Restore complete: ${OUTPUT}"
echo "Verify before swapping in:"
echo "  sqlite3 \"${OUTPUT}\" 'PRAGMA integrity_check;'"
echo "  sqlite3 \"${OUTPUT}\" 'SELECT count(*) FROM \"UsageSnapshot\";'"
echo ""
echo "To activate the restored file (stops serving traffic briefly - do this"
echo "from Render's Shell, then let Render's health check bring it back):"
echo "  cp ${LIVE_DB} ${LIVE_DB}.bak-\$(date +%Y%m%d-%H%M%S)   # keep the old file just in case"
echo "  cp \"${OUTPUT}\" ${LIVE_DB}"
echo "  # then restart the service from the Render dashboard so the running"
echo "  # process (and litestream, if replicating) reopen the swapped-in file."
echo ""
echo "Point-in-time restore (0.5.x): re-run with '-timestamp 2026-06-21T18:00:00Z'"
echo "or '-txid <hex>' inserted before the trailing \"${LIVE_DB}\" argument."
