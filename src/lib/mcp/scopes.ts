/**
 * The capability catalog for the MCP backend (docs/MCP_DESIGN.md). A personal
 * access token carries a SUBSET of these, chosen by its owner at creation —
 * this is the whole of what an AI assistant can be authorized to do, and it is
 * deliberately small: read, and help draft. There is no signing scope, no
 * submit/approve/pay scope, and no PDF-generation scope — those stay in the
 * human's hands in the app (invariant 3/9). Isomorphic (no server imports) so
 * both the token routes and the settings UI validate against the same list.
 */

export const MCP_SCOPES = [
  "receipts:read",
  "claims:read",
  "claims:draft",
  "ai:suggest",
  // Church master data (ministries/teams/positions). `catalog:read` lists the
  // catalogs; `catalog:draft` STAGES edits as drafts a human applies — never a
  // direct write. Both additionally require the manage role the app enforces
  // for that entity, so a token can never exceed what its owner could do.
  "catalog:read",
  "catalog:draft",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

export function isMcpScope(value: string): value is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(value);
}

/** Keep only recognized scopes, de-duplicated and in catalog order — so a
 *  stored/parsed scope list is always a clean subset of the catalog. */
export function normalizeScopes(values: readonly string[]): McpScope[] {
  const set = new Set(values);
  return MCP_SCOPES.filter((s) => set.has(s));
}

/**
 * Scopes that grant any read capability. The ministries catalog (reference
 * data both reading and drafting need) is available to any of these.
 */
export const READ_SCOPES: readonly McpScope[] = ["receipts:read", "claims:read", "claims:draft"];
