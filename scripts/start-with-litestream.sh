#!/usr/bin/env bash
# Render startCommand entrypoint. Replaces the raw
# "node scripts/migrate-safe.mjs && npm start" tail with an opt-in wrapper:
#
#   - LITESTREAM_S3_* unset (default): same logical behavior as the old
#     "node scripts/migrate-safe.mjs && npm start" — log one line, run
#     migrate-safe, then exec npm start. (Minor, intentional improvement over
#     the old `sh -c` form: `exec` makes npm start PID 1 so it receives Render's
#     SIGTERM directly instead of a wrapper shell swallowing it.)
#   - LITESTREAM_S3_* all set AND bin/litestream present (see
#     scripts/fetch-litestream.sh): restore from R2 if the disk has no DB yet
#     (fresh disk / disaster recovery), run migrate-safe, then exec litestream
#     as PID 1 with npm start as its supervised child (-exec), so every write
#     to /data/prod.db is continuously replicated to R2.
#
# migrate-safe.mjs runs exactly once in both paths, before the server starts,
# and always against the post-restore (or fresh) database file.
#
# Uses `exec` for the final process in each branch so it becomes PID 1 (or
# litestream's supervised child) and receives Render's SIGTERM directly for
# graceful shutdown — no wrapper shell left holding the signal.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LITESTREAM_BIN="${REPO_ROOT}/bin/litestream"
LITESTREAM_CONFIG="${REPO_ROOT}/litestream.yml"
DB_PATH="/data/prod.db"

log() {
  echo "[start-with-litestream] $*"
}

litestream_enabled() {
  [[ -n "${LITESTREAM_S3_BUCKET:-}" ]] \
    && [[ -n "${LITESTREAM_S3_ENDPOINT:-}" ]] \
    && [[ -n "${LITESTREAM_S3_ACCESS_KEY_ID:-}" ]] \
    && [[ -n "${LITESTREAM_S3_SECRET_ACCESS_KEY:-}" ]] \
    && [[ -x "${LITESTREAM_BIN}" ]]
}

if litestream_enabled; then
  log "replication ENABLED (LITESTREAM_S3_* set, bin/litestream present)."

  if [[ ! -f "${DB_PATH}" ]]; then
    log "no local DB at ${DB_PATH} — attempting restore from R2 replica (no-op if none exists yet)."
    "${LITESTREAM_BIN}" restore -config "${LITESTREAM_CONFIG}" -if-db-not-exists -if-replica-exists "${DB_PATH}"
  else
    log "local DB already present at ${DB_PATH} — skipping restore."
  fi

  node "${REPO_ROOT}/scripts/migrate-safe.mjs"

  log "starting litestream replicate (wraps npm start as its supervised process)."
  exec "${LITESTREAM_BIN}" replicate -config "${LITESTREAM_CONFIG}" -exec "npm start"
else
  log "replication DISABLED (set LITESTREAM_S3_BUCKET, LITESTREAM_S3_ENDPOINT,"
  log "LITESTREAM_S3_ACCESS_KEY_ID, LITESTREAM_S3_SECRET_ACCESS_KEY to enable — see docs/litestream.md)."

  node "${REPO_ROOT}/scripts/migrate-safe.mjs"

  exec npm start
fi
