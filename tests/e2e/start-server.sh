#!/usr/bin/env bash
# Boot a production server against a fresh, isolated test database.
set -euo pipefail
cd "$(dirname "$0")/../.."

export DATA_DIR="$PWD/.e2e-data"
export DATABASE_URL="file:$PWD/.e2e-data/numbers.db"
export AUTH_SECRET="e2e-secret-0123456789abcdef0123456789abcdef"
export AUTH_TRUST_HOST="true"
export AUTH_TEST_MODE="1"
export AI_MOCK="1"
export PORT=3100

rm -rf .e2e-data
mkdir -p .e2e-data

npx prisma generate > /dev/null

if [ ! -d .next ] || [ "${E2E_FORCE_BUILD:-0}" = "1" ]; then
  npx next build
fi

npx prisma db push --skip-generate > /dev/null

exec npx next start -p "$PORT"
