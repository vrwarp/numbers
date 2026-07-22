#!/bin/sh
# Boot sequence for the Numbers container: ensure the data volume is ready,
# apply any pending database migrations, then start the Next.js server.
#
# Optional PUID/PGID (the Synology / LinuxServer.io pattern): when either is
# set, the server runs as that uid:gid so files written to the /data volume are
# owned by the matching host user instead of root. Unset → runs as root exactly
# as before, so existing deployments are unaffected.
set -e

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR/uploads"

# RUN_AS is prefixed to each command below; empty means "stay root".
RUN_AS=""
if [ -n "$PUID" ] || [ -n "$PGID" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  # Reuse an existing group/user with these ids (the base image already has a
  # uid/gid 1000 "node"), otherwise create one.
  if ! getent group "$PGID" >/dev/null 2>&1; then
    groupadd -g "$PGID" numbers
  fi
  if ! getent passwd "$PUID" >/dev/null 2>&1; then
    useradd -o -u "$PUID" -g "$PGID" -M -s /usr/sbin/nologin numbers
  fi
  # The data volume and Next's runtime cache must be writable by the target user.
  chown -R "$PUID:$PGID" "$DATA_DIR" /app/.next 2>/dev/null || true
  RUN_AS="gosu $PUID:$PGID"
  echo "numbers: dropping privileges to uid:gid $PUID:$PGID"
fi

$RUN_AS prisma migrate deploy --schema=/app/prisma/schema.prisma

# Startup banner: name the running build and confirm which sharp/libvips binding
# is active. The from-source baseline build (this image) reports libvips 8.16.1;
# a stock prebuilt image would report sharp 0.34.5. Reading versions loads no
# image, so it is safe on any CPU and never crashes the boot.
echo "numbers: build ${BUILD_SHA:-unknown} | built $(cat /app/.build-date 2>/dev/null || echo unknown) | node $(node -v)"
$RUN_AS node -e "const s=require('sharp'); console.log('numbers: sharp '+s.versions.sharp+' / libvips '+s.versions.vips)" \
  || echo "numbers: sharp version check failed (binding did not load)"

# NODE_ARGS passes extra flags to node without rebuilding the image. Its one
# intended use is very old CPUs (e.g. an Atom without AVX) where V8's JIT can
# emit unsupported instructions: set NODE_ARGS=--jitless to run interpreter-only
# if the container still exits with SIGILL after the sharp rebuild. Empty by
# default; unquoted so multiple flags split into separate arguments.
exec $RUN_AS node ${NODE_ARGS:-} server.js
