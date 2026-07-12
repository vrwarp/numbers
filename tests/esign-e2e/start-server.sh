#!/usr/bin/env bash
# Boot a production server for the e-sign emulator e2e (docs/agent/TESTING.md):
# fresh isolated database, REAL Firestore backend (no ESIGN_MOCK). Expects to
# run under `firebase emulators:exec`, which provides the emulator host pair.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${FIRESTORE_EMULATOR_HOST:?run under firebase emulators:exec (see docs/agent/TESTING.md)}"
: "${FIREBASE_AUTH_EMULATOR_HOST:?run under firebase emulators:exec}"

export DATA_DIR="$PWD/.esign-e2e-data"
export DATABASE_URL="file:$PWD/.esign-e2e-data/numbers.db"
export AUTH_SECRET="esign-e2e-secret-0123456789abcdef0123456789abcdef"
export AUTH_TEST_MODE="1"
export AI_MOCK="1"
export ESIGN_ROOT_EMAIL="dana@example.com"
export FIREBASE_PROJECT_ID="demo-numbers"
export PUBLIC_BASE_URL="http://localhost:3101"
export PORT=3101

rm -rf .esign-e2e-data
mkdir -p .esign-e2e-data

npx prisma generate > /dev/null

if [ ! -d .next ] || [ "${E2E_FORCE_BUILD:-0}" = "1" ]; then
  npx next build
fi

npx prisma db push --skip-generate > /dev/null

exec npx next start -p "$PORT"
