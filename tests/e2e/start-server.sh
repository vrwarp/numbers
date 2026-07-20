#!/usr/bin/env bash
# Boot a production server against a fresh, isolated test database.
set -euo pipefail
cd "$(dirname "$0")/../.."

export DATA_DIR="$PWD/.e2e-data"
export DATABASE_URL="file:$PWD/.e2e-data/numbers.db"
export AUTH_SECRET="e2e-secret-0123456789abcdef0123456789abcdef"
export AUTH_TEST_MODE="1"
export AI_MOCK="1"

# Semantic search e2e (SEARCH_DESIGN §11): the app talks to a local REPLAY
# server that serves REAL vectors recorded from the live endpoint
# (npm run record:embeddings) — genuine model geometry, zero network. Model
# and dim come from the recording so re-recording needs no edits here.
kill "$(lsof -t -i:3197 2>/dev/null)" 2>/dev/null || true
node tests/e2e/mock-embedding-server.mjs &
MOCK_EMBED_PID=$!
trap 'kill "$MOCK_EMBED_PID" 2>/dev/null || true' EXIT
export EMBEDDING_ENDPOINT="http://127.0.0.1:3197"
export EMBEDDING_API_KEY="e2e-replay"
# NB: node -p colorizes non-string values when it feels like it — write() only.
export EMBEDDING_MODEL="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('tests/e2e/embedding-fixtures/embeddings.json','utf8')).model))")"
export EMBEDDING_DIM="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('tests/e2e/embedding-fixtures/embeddings.json','utf8')).dim))")"
export EMBEDDING_MIN_SCORE="0.15"
export EMBEDDING_DRAFT_IDLE_MS="1500"
export EMBEDDING_POLL_MS="500"
# Background receipt annotation: DORMANT by default (a pace far longer than
# the run, gating the first call too) so every spec runs with deterministic
# claim-time inline extraction — the drip would otherwise stamp merchants on
# other specs' receipts at unpredictable moments (chip counts, search exact
# matches). background-annotation.spec.ts flips the pace to 0 through the
# DATA_DIR config.json hot-reload for its own scenario and restores it after.
export EXTRACTION_PACE_MS="900000"
export EXTRACTION_POLL_MS="250"
export PORT=3100

rm -rf .e2e-data
mkdir -p .e2e-data

npx prisma generate > /dev/null

if [ ! -d .next ] || [ "${E2E_FORCE_BUILD:-0}" = "1" ]; then
  npx next build
fi

npx prisma db push --skip-generate > /dev/null

exec npx next start -p "$PORT"
