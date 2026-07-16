import { PrismaClient } from "@prisma/client";

/**
 * SQLite concurrency posture (docs/SEARCH_DESIGN.md §4): the embedding worker
 * is a persistent second writer beside request handlers, and busy_timeout is
 * per-connection while Prisma pools connections — so serialization is enforced
 * HERE, the one anchor every consumer goes through, not in deployment config:
 * connection_limit=1 (full write serialization; church scale tolerates it —
 * nothing holds a transaction across a network call) plus WAL and a busy
 * timeout as belt-and-suspenders for any second connection that appears.
 */
function datasourceUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || !url.startsWith("file:")) return url;
  if (/[?&]connection_limit=/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "connection_limit=1";
}

function createClient(): PrismaClient {
  const url = datasourceUrl();
  const client = url ? new PrismaClient({ datasourceUrl: url }) : new PrismaClient();
  // Fire-and-forget: pragma failures (e.g. a non-file datasource) must not
  // block startup; WAL is a database-file property, busy_timeout per-connection.
  client
    .$executeRawUnsafe("PRAGMA journal_mode=WAL;")
    .then(() => client.$executeRawUnsafe("PRAGMA busy_timeout=5000;"))
    .catch(() => {});
  return client;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
