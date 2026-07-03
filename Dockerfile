# ---- Numbers: single-container deployment ----
# Build:  docker build -t numbers .
# Run:    docker run -d -p 3000:3000 -v /path/on/host/data:/data \
#           -e AUTH_SECRET=... \
#           -e FIREBASE_API_KEY=... -e FIREBASE_AUTH_DOMAIN=... \
#           -e FIREBASE_PROJECT_ID=... \
#           -e OPENROUTER_API_KEY=... numbers
# Everything persistent (SQLite db + receipt files) lives in /data.

FROM node:22-bookworm-slim AS base
WORKDIR /app

# ---- dependencies ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

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

# openssl for Prisma's query engine; prisma CLI to run migrations on boot.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g prisma@6

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/assets ./assets
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME /data
EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
