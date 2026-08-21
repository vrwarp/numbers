#!/usr/bin/env bash
# Boot a production server against the seeded perf dataset (.perf-data/).
# PERF_RESET=1 wipes and re-seeds; otherwise the dataset persists across runs.
set -euo pipefail
cd "$(dirname "$0")/../.."

export DATA_DIR="$PWD/.perf-data"
export DATABASE_URL="file:$PWD/.perf-data/perf.db"
export AUTH_SECRET="perf-secret-0123456789abcdef0123456789abcdef"
export AUTH_TEST_MODE="1"
export AI_MOCK="1"
export PUSH_MOCK="1"
export EMBEDDING_MOCK="1"
# Keep the drip worker dormant so measurements see steady-state request cost,
# not a provider call racing the benchmark.
export EXTRACTION_PACE_MS="900000"
export PORT="${PORT:-3200}"

# A server already on this port would keep serving its OWN (pre-rebuild) build
# while `next start` here dies with EADDRINUSE in the background — the symptom
# is a ChunkLoadError in the browser and measurements silently taken against
# stale code. Refuse to start instead, and say what to do about it.
if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null ||
   curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/signin" 2>/dev/null; then
  echo "ERROR: something is already serving port $PORT." >&2
  echo "It would keep serving its old build while this one fails to bind." >&2
  echo "Stop it first, e.g.:  kill \$(lsof -t -i:$PORT)" >&2
  exit 1
fi

if [ "${PERF_RESET:-0}" = "1" ]; then rm -rf .perf-data; fi
mkdir -p .perf-data

npx prisma generate > /dev/null

if [ ! -d .next ] || [ "${PERF_FORCE_BUILD:-0}" = "1" ]; then
  npx next build
fi

npx prisma db push --skip-generate > /dev/null
npx tsx scripts/perf/seed.ts

exec npx next start -p "$PORT"
