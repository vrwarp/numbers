#!/bin/sh
# Boot sequence for the Numbers container: ensure the data volume is ready,
# apply any pending database migrations, then start the Next.js server.
set -e

mkdir -p "${DATA_DIR:-/data}/uploads"

prisma migrate deploy --schema=/app/prisma/schema.prisma

exec node server.js
