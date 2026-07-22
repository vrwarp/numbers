#!/bin/sh
# Boot sequence for the Numbers container: ensure the data volume is ready,
# apply any pending database migrations, then start the Next.js server.
set -e

mkdir -p "${DATA_DIR:-/data}/uploads"

prisma migrate deploy --schema=/app/prisma/schema.prisma

# NODE_ARGS passes extra flags to node without rebuilding the image. Its one
# intended use is very old CPUs (e.g. an Atom without AVX) where V8's JIT can
# emit unsupported instructions: set NODE_ARGS=--jitless to run interpreter-only
# if the container still exits with SIGILL after the sharp rebuild. Empty by
# default; unquoted so multiple flags split into separate arguments.
exec node ${NODE_ARGS:-} server.js
