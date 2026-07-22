#!/bin/sh
# Boot sequence for the Numbers container: ensure the data volume is ready,
# apply any pending database migrations, then start the Next.js server.
set -e

mkdir -p "${DATA_DIR:-/data}/uploads"

prisma migrate deploy --schema=/app/prisma/schema.prisma

# Startup banner: name the running build and confirm which sharp/libvips binding
# is active. The from-source baseline build (this image) reports libvips 8.16.1;
# a stock prebuilt image would report sharp 0.34.5. Reading versions loads no
# image, so it is safe on any CPU and never crashes the boot.
echo "numbers: build ${BUILD_SHA:-unknown} | built $(cat /app/.build-date 2>/dev/null || echo unknown) | node $(node -v)"
node -e "const s=require('sharp'); console.log('numbers: sharp '+s.versions.sharp+' / libvips '+s.versions.vips)" \
  || echo "numbers: sharp version check failed (binding did not load)"

# NODE_ARGS passes extra flags to node without rebuilding the image. Its one
# intended use is very old CPUs (e.g. an Atom without AVX) where V8's JIT can
# emit unsupported instructions: set NODE_ARGS=--jitless to run interpreter-only
# if the container still exits with SIGILL after the sharp rebuild. Empty by
# default; unquoted so multiple flags split into separate arguments.
exec node ${NODE_ARGS:-} server.js
