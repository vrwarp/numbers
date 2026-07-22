# ---- Numbers: single-container deployment ----
# Build:  docker build -t numbers .
# Run:    docker run -d -p 3000:3000 -v /path/on/host/data:/data \
#           -e AUTH_SECRET=... \
#           -e FIREBASE_API_KEY=... -e FIREBASE_AUTH_DOMAIN=... \
#           -e FIREBASE_PROJECT_ID=... \
#           -e OPENROUTER_API_KEY=... numbers
# Everything persistent (SQLite db + receipt files) lives in /data.
#
# Debian trixie base: it ships libvips 8.16.1 built for the generic x86-64
# baseline (SSE2) with runtime SIMD dispatch, so the image runs on CPUs that
# lack SSE4.2/AVX — e.g. the Intel Atom D2700 in older Synology NAS units. sharp
# is rebuilt against THIS libvips (see the deps stage) instead of shipping its
# prebuilt @img/sharp-libvips binary, which is compiled with SSE4.2 and dies
# with SIGILL (illegal instruction) on such CPUs the moment it touches an image.
#
# NOTE: sharp is pinned to 0.34.2 in package.json precisely because that is the
# newest release whose required libvips (>=8.16.1) matches trixie's — 0.34.3+
# needs 8.17.x, which no Debian stable ships yet. Bump sharp only alongside a
# base image whose libvips satisfies the new floor (Debian 14, or trixie
# backports), or the from-source rebuild below will fail to compile.
FROM node:22-trixie-slim AS base
WORKDIR /app
# Runtime libvips for sharp. Present in every stage so the from-source sharp
# binding can load it during `next build` and at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libvips42t64 \
    && rm -rf /var/lib/apt/lists/*

# ---- dependencies ----
FROM base AS deps
# Build toolchain + libvips headers so sharp's native binding compiles from
# source against the system libvips.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 pkg-config libvips-dev \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
# Rebuild the app's sharp against the baseline system libvips. Deleting its
# prebuilt @img packages (SSE4.2 → SIGILL on Atom D2700) makes sharp's install
# script compile from source (against system libvips, whose 8.16.1 exactly meets
# sharp 0.34.2's minimum) and its runtime loader fall through to that build.
# Next carries its OWN optional sharp copy; it's deleted too so `npm rebuild`
# only touches the app's copy and no SSE4.2 binary ships — Next's image
# optimizer is off (images.unoptimized in next.config), so it's never needed.
# Only sharp's @img packages go, so @napi-rs/canvas keeps its own binary. The
# require() smoke test fails the build loudly if the binding won't link.
RUN rm -rf node_modules/@img/sharp-linux-x64 node_modules/@img/sharp-libvips-linux-x64 \
           node_modules/next/node_modules/sharp node_modules/next/node_modules/@img \
    && SHARP_FORCE_GLOBAL_LIBVIPS=1 npm rebuild --build-from-source --foreground-scripts sharp \
    && node -e "const s=require('sharp'); console.log('sharp', s.versions.sharp, 'linked libvips', s.versions.vips)"

# ---- build ----
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ---- runtime ----
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    DATABASE_URL=file:/data/numbers.db

# Commit that produced this image — surfaced by feedback reports so a bug names
# its deploy (read at runtime via configValue("BUILD_SHA"); empty when unset).
ARG BUILD_SHA=""
ENV BUILD_SHA=${BUILD_SHA}

# openssl for Prisma's query engine; prisma CLI to run migrations on boot;
# fonts-dejavu-core so @napi-rs/canvas can draw the PDF-preview truncation notice
# (the base image ships no fonts, so fillText would otherwise render nothing).
# libvips runtime comes from the base stage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g prisma@6

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Overlay the complete from-source sharp: its native binding lives inside the
# package (src/build/Release), not a separate @img package, and Next's
# standalone tracer can miss that dynamically-required .node. Copying the whole
# package guarantees the baseline-libvips binding ships.
COPY --from=deps /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/assets ./assets
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Stamp the image build time for the startup banner (accurate on a --no-cache
# build; on a cached build it reflects when this layer was last rebuilt).
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && date -u +"%Y-%m-%dT%H:%M:%SZ" > /app/.build-date

VOLUME /data
EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
