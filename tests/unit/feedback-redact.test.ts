import { describe, expect, it } from "vitest";
import { templatePath, scrubText } from "@/lib/feedback/redact";
import { isSensitiveRoute, routeTemplate } from "@/lib/feedback/sensitive";

/**
 * The feedback capture privacy boundary (docs/FEEDBACK_DESIGN.md §3), guarded
 * by test the way the other invariants are. If redaction rots, this goes red.
 */

describe("templatePath", () => {
  it("collapses cuid ids to [id]", () => {
    expect(templatePath("/claims/ckz9a1b2c3d4e5f6g7h8i9j0")).toBe("/claims/[id]");
    expect(templatePath("/api/reimbursements/ckz9a1b2c3d4e5f6g7h8i9j0/pdf")).toBe(
      "/api/reimbursements/[id]/pdf"
    );
  });

  it("collapses numeric ids, uuids, and long tokens", () => {
    expect(templatePath("/api/line-items/12345")).toBe("/api/line-items/[n]");
    expect(templatePath("/x/550e8400-e29b-41d4-a716-446655440000")).toBe("/x/[id]");
    expect(templatePath("/c/AbCdEf0123456789AbCdEf0123456789")).toBe("/c/[token]");
  });

  it("drops query and hash", () => {
    expect(templatePath("/search?q=secret+text#frag")).toBe("/search");
  });

  it("strips an absolute origin", () => {
    expect(templatePath("https://numbers.example.org/api/receipts/ckz9a1b2c3d4e5f6g7h8i9j0")).toBe(
      "/api/receipts/[id]"
    );
  });

  it("leaves plain static routes intact", () => {
    expect(templatePath("/approvals")).toBe("/approvals");
    expect(templatePath("/")).toBe("/");
  });
});

describe("scrubText", () => {
  it("removes money-shaped runs", () => {
    expect(scrubText("total was $48.20 not 1,234.56")).toBe("total was [amt] not [amt]");
  });

  it("removes long digit runs and opaque tokens", () => {
    expect(scrubText("id 123456789 here")).toBe("id [num] here");
    expect(scrubText("token AbCdEf0123456789AbCdEf0123456789xyz")).toBe("token [token]");
  });

  it("caps length", () => {
    // Spaces so no single 24+ run is collapsed to [token] before the cap.
    const out = scrubText("ab ".repeat(400), 100);
    expect(out.length).toBe(101); // 100 + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("no amount survives a scrub", () => {
    const samples = ["$0.99", "charged 12.00 refunded 3.50", "grand total 9,999.99"];
    for (const s of samples) expect(/\d[\d,]*\.\d{2}/.test(scrubText(s))).toBe(false);
  });
});

describe("isSensitiveRoute", () => {
  it("flags other-member surfaces", () => {
    for (const p of ["/approvals", "/finance", "/members", "/vouch", "/v/abc", "/c/tok"]) {
      expect(isSensitiveRoute(p)).toBe(true);
    }
  });

  it("does not flag the reporter's own surfaces", () => {
    for (const p of ["/", "/claims/x", "/shoebox", "/search", "/profile"]) {
      expect(isSensitiveRoute(p)).toBe(false);
    }
  });

  it("routeTemplate redacts the current path", () => {
    expect(routeTemplate("/claims/ckz9a1b2c3d4e5f6g7h8i9j0?open=1")).toBe("/claims/[id]");
  });
});
