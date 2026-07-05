#!/usr/bin/env bash
set -euo pipefail

# Parse SQLite DB path from DATABASE_URL if present, defaulting to /data/prod.db
DB_URL="${DATABASE_URL:-file:/data/prod.db}"
DB_PATH="${DB_URL#file:}"

echo "[start] DATABASE_URL: $DB_URL"
echo "[start] SQLite path: $DB_PATH"

# 1. Attempt to restore if the SQLite file doesn't exist
if [ ! -f "$DB_PATH" ]; then
  if [ -n "${LITESTREAM_S3_BUCKET:-}" ]; then
    echo "[start] Local database not found. Attempting Litestream restore..."
    # Make sure output directory exists
    mkdir -p "$(dirname "$DB_PATH")"
    bash scripts/litestream-restore.sh "$DB_PATH"
  else
    echo "[start] Local database not found and LITESTREAM_S3_BUCKET not set. Skipping restore."
  fi
else
  echo "[start] Local database already exists. Skipping restore."
fi

# 2. Start Litestream replication in background if configured
if [ -n "${LITESTREAM_S3_BUCKET:-}" ]; then
  echo "[start] Starting Litestream replication in background..."
  ./bin/litestream replicate -config ./litestream.yml &
  LITESTREAM_PID=$!
  trap 'echo "[start] Stopping Litestream (PID $LITESTREAM_PID)..."; kill $LITESTREAM_PID 2>/dev/null || true' EXIT
else
  echo "[start] LITESTREAM_S3_BUCKET not configured. Running without Litestream replication."
fi

# 3. Run safe migration
echo "[start] Running safe schema migrations..."
node scripts/migrate-safe.mjs

# 4. Start Next.js server
echo "[start] Starting Next.js application..."
npm start
