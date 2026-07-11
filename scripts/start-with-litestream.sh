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
# Partial replication configuration, a configured replica with no verified
# binary, or LITESTREAM_REQUIRED=true without an active replica is a startup
# error. This prevents a deploy from silently running without its intended
# backup path.
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
LITESTREAM_BIN="${LITESTREAM_BIN_PATH:-${REPO_ROOT}/bin/litestream}"
LITESTREAM_CONFIG="${REPO_ROOT}/litestream.yml"
DB_PATH="/data/prod.db"
export APP_STARTUP_WRAPPER="start-with-litestream-v2"

log() {
  echo "[start-with-litestream] $*"
}

REQUIRED_KEYS=(
  LITESTREAM_S3_BUCKET
  LITESTREAM_S3_ENDPOINT
  LITESTREAM_S3_ACCESS_KEY_ID
  LITESTREAM_S3_SECRET_ACCESS_KEY
)

case "${LITESTREAM_REQUIRED:-false}" in
  true|false) ;;
  *)
    log "ERROR: LITESTREAM_REQUIRED must be exactly true or false."
    exit 1
    ;;
esac

configured_keys=0
for key in "${REQUIRED_KEYS[@]}"; do
  if [[ -n "${!key:-}" ]]; then
    configured_keys=$((configured_keys + 1))
  fi
done

if (( configured_keys > 0 && configured_keys < ${#REQUIRED_KEYS[@]} )); then
  log "ERROR: Litestream is partially configured (${configured_keys}/${#REQUIRED_KEYS[@]} required values set)."
  log "Set all bucket/endpoint/access-key-id/secret-access-key values together, or unset all four."
  exit 1
fi

litestream_enabled=false
if (( configured_keys == ${#REQUIRED_KEYS[@]} )); then
  if [[ ! -x "${LITESTREAM_BIN}" ]]; then
    log "ERROR: Litestream is configured but the verified binary is unavailable at ${LITESTREAM_BIN}."
    exit 1
  fi
  litestream_enabled=true
elif [[ "${LITESTREAM_REQUIRED:-false}" == "true" ]]; then
  log "ERROR: LITESTREAM_REQUIRED=true but no replica credentials are configured."
  exit 1
fi

if [[ "${STARTUP_PREFLIGHT_ONLY:-false}" == "true" ]]; then
  log "preflight OK (replication ${litestream_enabled})."
  exit 0
fi

if [[ "${litestream_enabled}" == "true" ]]; then
  export LITESTREAM_ACTIVE=true
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
  export LITESTREAM_ACTIVE=false
  log "replication DISABLED (set LITESTREAM_S3_BUCKET, LITESTREAM_S3_ENDPOINT,"
  log "LITESTREAM_S3_ACCESS_KEY_ID, LITESTREAM_S3_SECRET_ACCESS_KEY to enable — see docs/litestream.md)."

  node "${REPO_ROOT}/scripts/migrate-safe.mjs"

  exec npm start
fi
