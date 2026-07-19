import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  approverEligibility,
  pickSuggestedApprover,
  builtinPositionKey,
  customPositionName,
  DEFAULT_POSITION_ENTRIES,
  type ApproverEligibility,
  type PositionForSuggest,
} from "@/lib/positions";

describe("customPositionName", () => {
  const set = { name: "Youth Deacon", nameZhHans: "青年执事", nameZhHant: "青年執事" };
  it("returns the per-locale name for zh, English for en", () => {
    expect(customPositionName(set, "en")).toBe("Youth Deacon");
    expect(customPositionName(set, "zh-Hans")).toBe("青年执事");
    expect(customPositionName(set, "zh-Hant")).toBe("青年執事");
  });
  it("falls back to the English name when a locale column is blank/null", () => {
    expect(customPositionName({ name: "Youth Deacon", nameZhHans: null, nameZhHant: "" }, "zh-Hans")).toBe(
      "Youth Deacon"
    );
    expect(customPositionName({ name: "Youth Deacon", nameZhHans: "  ", nameZhHant: null }, "zh-Hant")).toBe(
      "Youth Deacon"
    );
  });
});

describe("DEFAULT_POSITION_ENTRIES", () => {
  it("is the standing deacon roster, active and in a stable order", () => {
    expect(DEFAULT_POSITION_ENTRIES.map((e) => e.name)).toEqual([
      "Chinese Caring Deacon",
      "Chinese Evangelism Deacon",
      "Children's Ministry Deacon",
      "English Discipleship Deacon",
      "English Evangelism Deacon",
      "Finance Deacon",
      "General Affairs Deacon",
      "Missions Deacon",
      "Property Deacon",
      "Worship Deacon",
    ]);
    DEFAULT_POSITION_ENTRIES.forEach((e, i) => {
      expect(e.active).toBe(true);
      expect(e.description).toBe("");
      expect(e.sortOrder).toBe(i);
      expect(e.key).toBeTruthy();
    });
  });

  it("every default has a localized name in every catalog (en/zh-Hans/zh-Hant)", () => {
    const dir = path.join(process.cwd(), "messages");
    for (const locale of ["en", "zh-Hans", "zh-Hant"]) {
      const builtin = JSON.parse(fs.readFileSync(path.join(dir, `${locale}.json`), "utf8"))
        .Positions.builtin as Record<string, string>;
      for (const e of DEFAULT_POSITION_ENTRIES) {
        expect(builtin[e.key]?.trim(), `${locale}: Positions.builtin.${e.key}`).toBeTruthy();
      }
    }
  });
});

describe("builtinPositionKey", () => {
  it("maps a canonical default name to its i18n key (trimming whitespace)", () => {
    expect(builtinPositionKey("Chinese Caring Deacon")).toBe("chineseCaring");
    expect(builtinPositionKey("  Worship Deacon  ")).toBe("worship");
  });
  it("returns null for a custom, treasurer-authored name", () => {
    expect(builtinPositionKey("Office Staff")).toBeNull();
    expect(builtinPositionKey("Deacon of Missions")).toBeNull();
    expect(builtinPositionKey("")).toBeNull();
  });
});

describe("approverEligibility", () => {
  it("is ok only for an attested Approver+ with approvals active", () => {
    expect(approverEligibility({ role: "approver", attested: true, approvalsPaused: false })).toBe("ok");
    expect(approverEligibility({ role: "treasurer", attested: true, approvalsPaused: false })).toBe("ok");
    expect(approverEligibility({ role: "admin", attested: true, approvalsPaused: false })).toBe("ok");
  });
  it("is paused for an eligible approver who paused approvals (A10)", () => {
    expect(approverEligibility({ role: "approver", attested: true, approvalsPaused: true })).toBe("paused");
  });
  it("cannotApprove for a plain member or an un-attested key", () => {
    expect(approverEligibility({ role: "member", attested: true, approvalsPaused: false })).toBe("cannotApprove");
    expect(approverEligibility({ role: "approver", attested: false, approvalsPaused: false })).toBe("cannotApprove");
  });
  it("chairman/secretary are approver-plus (A11): ok when attested and active", () => {
    expect(approverEligibility({ role: "chairman", attested: true, approvalsPaused: false })).toBe("ok");
    expect(approverEligibility({ role: "secretary", attested: true, approvalsPaused: false })).toBe("ok");
    expect(approverEligibility({ role: "chairman", attested: true, approvalsPaused: true })).toBe("paused");
    expect(approverEligibility({ role: "secretary", attested: false, approvalsPaused: false })).toBe("cannotApprove");
  });
});

// Helper builders keep the selection cases readable.
const pos = (name: string, holderUserIds: string[], active = true): PositionForSuggest => ({
  name,
  nameZhHans: null,
  nameZhHant: null,
  active,
  holderUserIds,
});
const elig = (m: Record<string, ApproverEligibility>) => new Map(Object.entries(m));

describe("pickSuggestedApprover", () => {
  it("returns null when no category has a default position", () => {
    const out = pickSuggestedApprover({
      lineItems: [{ ministry: "210 Missions", amountCents: 5000 }],
      categoryDefault: new Map([["210", null]]),
      positions: new Map(),
      eligibility: new Map(),
      ownerUserId: "owner",
    });
    expect(out).toBeNull();
  });

  it("pre-fills the first eligible holder (primary) of the resolved position", () => {
    const out = pickSuggestedApprover({
      lineItems: [{ ministry: "210 Missions", amountCents: 5000 }],
      categoryDefault: new Map([["210", "pDeacon"]]),
      positions: new Map([["pDeacon", pos("Deacon of Missions", ["jane", "mike"])]]),
      eligibility: elig({ jane: "ok", mike: "ok" }),
      ownerUserId: "owner",
    });
    expect(out).toEqual({
      userId: "jane",
      positionId: "pDeacon",
      positionName: { name: "Deacon of Missions", nameZhHans: null, nameZhHant: null },
    });
  });

  it("skips ineligible/paused holders and takes the next eligible backup", () => {
    const out = pickSuggestedApprover({
      lineItems: [{ ministry: "210 Missions", amountCents: 5000 }],
      categoryDefault: new Map([["210", "pDeacon"]]),
      positions: new Map([["pDeacon", pos("Deacon", ["priya", "mike"])]]),
      eligibility: elig({ priya: "cannotApprove", mike: "ok" }),
      ownerUserId: "owner",
    });
    expect(out?.userId).toBe("mike");
  });

  it("never pre-fills the requestor as their own approver", () => {
    const out = pickSuggestedApprover({
      lineItems: [{ ministry: "210 Missions", amountCents: 5000 }],
      categoryDefault: new Map([["210", "pDeacon"]]),
      positions: new Map([["pDeacon", pos("Deacon", ["owner", "mike"])]]),
      eligibility: elig({ owner: "ok", mike: "ok" }),
      ownerUserId: "owner",
    });
    expect(out?.userId).toBe("mike");
  });

  it("guesses the largest-dollar category's position on a multi-category claim", () => {
    const out = pickSuggestedApprover({
      lineItems: [
        { ministry: "210 Missions", amountCents: 2000 }, // Deacon: $20
        { ministry: "310 Office", amountCents: 9000 }, // Staff: $90 → wins
      ],
      categoryDefault: new Map([
        ["210", "pDeacon"],
        ["310", "pStaff"],
      ]),
      positions: new Map([
        ["pDeacon", pos("Deacon", ["jane"])],
        ["pStaff", pos("Staff", ["sam"])],
      ]),
      eligibility: elig({ jane: "ok", sam: "ok" }),
      ownerUserId: "owner",
    });
    expect(out?.userId).toBe("sam");
    expect(out?.positionName.name).toBe("Staff");
  });

  it("falls through to the next-ranked position when the top one has no eligible holder", () => {
    const out = pickSuggestedApprover({
      lineItems: [
        { ministry: "210 Missions", amountCents: 2000 },
        { ministry: "310 Office", amountCents: 9000 }, // top dollars, but no eligible holder
      ],
      categoryDefault: new Map([
        ["210", "pDeacon"],
        ["310", "pStaff"],
      ]),
      positions: new Map([
        ["pDeacon", pos("Deacon", ["jane"])],
        ["pStaff", pos("Staff", ["priya"])],
      ]),
      eligibility: elig({ jane: "ok", priya: "cannotApprove" }),
      ownerUserId: "owner",
    });
    expect(out?.userId).toBe("jane");
  });

  it("ignores archived positions and free-text (uncoded) ministries", () => {
    const out = pickSuggestedApprover({
      lineItems: [
        { ministry: "Coffee run", amountCents: 5000 }, // no code
        { ministry: "210 Missions", amountCents: 3000 },
      ],
      categoryDefault: new Map([["210", "pDeacon"]]),
      positions: new Map([["pDeacon", pos("Deacon", ["jane"], false)]]), // archived
      eligibility: elig({ jane: "ok" }),
      ownerUserId: "owner",
    });
    expect(out).toBeNull();
  });
});
