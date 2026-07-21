import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { normalizeScopes, type McpScope } from "@/lib/mcp/scopes";

/**
 * Personal access tokens for the MCP backend (docs/MCP_DESIGN.md). SERVER ONLY
 * (prisma + crypto).
 *
 * The secret is high-entropy random (256 bits), so it is stored only as a
 * SHA-256 hash — a fast hash is the right primitive here (unlike a password,
 * there is nothing to brute-force), and verification is an indexed point lookup
 * on that hash. The raw secret is returned exactly once, at creation, and never
 * again: a database read can never reveal a live token (invariant: no secrets
 * over MCP, applied to the store itself).
 */

/** Scheme prefix on every secret, so a leaked string is recognizable (and
 *  secret-scanners can match it) — mirrors the `sk-`/`ghp_` convention. */
const TOKEN_PREFIX = "nmbr_pat_";
/** Random bytes in the secret body (base64url ≈ 43 chars for 32 bytes). */
const SECRET_BYTES = 32;

export interface McpTokenRecord {
  id: string;
  label: string;
  prefix: string;
  scopes: McpScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface VerifiedToken {
  tokenId: string;
  userId: string;
  scopes: McpScope[];
}

export function hashToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Mint a fresh secret and its stored derivatives. The `prefix` is a non-secret
 *  display hint (scheme + first 6 chars of the body) so two tokens are
 *  distinguishable in the list without ever re-showing the secret. */
function mintSecret(): { secret: string; hash: string; prefix: string } {
  const body = randomBytes(SECRET_BYTES).toString("base64url");
  const secret = `${TOKEN_PREFIX}${body}`;
  return { secret, hash: hashToken(secret), prefix: `${TOKEN_PREFIX}${body.slice(0, 6)}` };
}

function toRecord(row: {
  id: string;
  label: string;
  prefix: string;
  scopesJson: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}): McpTokenRecord {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    scopes: parseScopes(row.scopesJson),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

function parseScopes(json: string): McpScope[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? normalizeScopes(arr.filter((s) => typeof s === "string")) : [];
  } catch {
    return [];
  }
}

/** Create a token for a user. Returns the one-time secret alongside the stored
 *  (secret-free) record — the caller shows the secret once and discards it. */
export async function createMcpToken(
  userId: string,
  label: string,
  scopes: McpScope[],
  expiresAt: Date | null
): Promise<{ secret: string; record: McpTokenRecord }> {
  const { secret, hash, prefix } = mintSecret();
  const row = await prisma.mcpToken.create({
    data: {
      userId,
      label: label.slice(0, 100),
      tokenHash: hash,
      prefix,
      scopesJson: JSON.stringify(normalizeScopes(scopes)),
      expiresAt,
    },
  });
  return { secret, record: toRecord(row) };
}

/** The user's tokens, newest first — never includes the hash or secret. */
export async function listMcpTokens(userId: string): Promise<McpTokenRecord[]> {
  const rows = await prisma.mcpToken.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toRecord);
}

/** Revoke a token the caller owns. Returns false (→ 404) on any miss, so a
 *  token id is never confirmed to exist for a non-owner (invariant 2). */
export async function revokeMcpToken(userId: string, id: string): Promise<boolean> {
  const row = await prisma.mcpToken.findFirst({ where: { id, userId } });
  if (!row) return false;
  if (!row.revokedAt) {
    await prisma.mcpToken.update({ where: { id }, data: { revokedAt: new Date() } });
  }
  return true;
}

/**
 * Resolve a presented bearer secret to its owner + granted scopes, or null.
 * A malformed, unknown, revoked, or expired token yields null (the MCP layer
 * turns that into a 401). The last-used touch is fire-and-forget — token
 * telemetry must never gate or fail a request.
 */
export async function verifyMcpTokenSecret(secret: string, now = new Date()): Promise<VerifiedToken | null> {
  if (typeof secret !== "string" || !secret.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(secret);
  const row = await prisma.mcpToken.findUnique({ where: { tokenHash: hash } });
  if (!row) return null;
  // Defense-in-depth: the lookup already matched on the full hash, but compare
  // in constant time so token verification never leaks via timing.
  if (!constantTimeEqual(row.tokenHash, hash)) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;

  prisma.mcpToken
    .update({ where: { id: row.id }, data: { lastUsedAt: now } })
    .catch(() => {});

  return { tokenId: row.id, userId: row.userId, scopes: parseScopes(row.scopesJson) };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
