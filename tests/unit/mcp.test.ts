import { describe, expect, it } from "vitest";
import { MCP_SCOPES, isMcpScope, normalizeScopes, READ_SCOPES } from "@/lib/mcp/scopes";
import { hashToken, verifyMcpTokenSecret } from "@/lib/mcp/tokens";

/**
 * Pure MCP-layer guarantees (no DB): the scope catalog, and the token hashing +
 * malformed-token rejection that gate the backend. Anything touching Prisma is
 * covered by e2e, not here.
 */

describe("mcp scopes", () => {
  it("has no signing/submit/approval/pdf capability", () => {
    // The whole point: MCP can read and draft, never sign or move a claim.
    for (const s of MCP_SCOPES) {
      expect(s).not.toMatch(/sign|submit|approv|pdf|pay|generate/i);
    }
  });

  it("recognizes the catalog + feedback scopes", () => {
    expect(isMcpScope("claims:read")).toBe(true);
    expect(isMcpScope("catalog:draft")).toBe(true);
    expect(isMcpScope("feedback:read")).toBe(true);
    expect(isMcpScope("feedback:triage")).toBe(true);
    expect(isMcpScope("claims:submit")).toBe(false);
    expect(isMcpScope("")).toBe(false);
  });

  it("normalizes to a clean, ordered, deduped subset", () => {
    expect(normalizeScopes(["claims:read", "bogus", "claims:read", "receipts:read"])).toEqual([
      "receipts:read",
      "claims:read",
    ]);
    expect(normalizeScopes(["nope"])).toEqual([]);
  });

  it("keeps the draft scope in the read set (ministries reference data)", () => {
    expect(READ_SCOPES).toContain("claims:draft");
  });
});

describe("mcp token hashing", () => {
  it("hashes deterministically and differs per secret", () => {
    expect(hashToken("nmbr_pat_abc")).toBe(hashToken("nmbr_pat_abc"));
    expect(hashToken("nmbr_pat_abc")).not.toBe(hashToken("nmbr_pat_xyz"));
    expect(hashToken("nmbr_pat_abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a malformed bearer without touching the database", async () => {
    // No `nmbr_pat_` prefix → resolved to null before any Prisma call.
    expect(await verifyMcpTokenSecret("")).toBeNull();
    expect(await verifyMcpTokenSecret("Bearer something")).toBeNull();
    expect(await verifyMcpTokenSecret("ghp_notours")).toBeNull();
  });
});
