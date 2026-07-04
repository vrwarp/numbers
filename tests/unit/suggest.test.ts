import { afterEach, describe, expect, it } from "vitest";
import {
  buildSuggestionPrompt,
  mockSuggest,
  parseSuggestionResponse,
  resolveSuggestedMinistry,
  suggestMinistryEvent,
} from "@/lib/ai/suggest";
import { MINISTRIES } from "@/lib/ministries";

describe("buildSuggestionPrompt", () => {
  it("includes every budget category and the user's description", () => {
    const prompt = buildSuggestionPrompt("snacks for VBS", null);
    for (const m of MINISTRIES) expect(prompt).toContain(m);
    expect(prompt).toContain('"snacks for VBS"');
    expect(prompt).not.toContain("Church-specific context");
  });

  it("embeds the church-context document when present", () => {
    const prompt = buildSuggestionPrompt("gas for the retreat", "Ember is a small group");
    expect(prompt).toContain("Church-specific context");
    expect(prompt).toContain("Ember is a small group");
  });
});

describe("resolveSuggestedMinistry", () => {
  it("accepts exact list entries", () => {
    expect(resolveSuggestedMinistry("470 Summer Retreat")).toBe("470 Summer Retreat");
  });

  it("matches case-insensitively", () => {
    expect(resolveSuggestedMinistry("470 summer retreat")).toBe("470 Summer Retreat");
  });

  it("matches by leading account number when the name drifted", () => {
    expect(resolveSuggestedMinistry("470 Retreat")).toBe("470 Summer Retreat");
    expect(resolveSuggestedMinistry("470")).toBe("470 Summer Retreat");
  });

  it("returns null for made-up categories, blanks and null", () => {
    expect(resolveSuggestedMinistry("General Fund")).toBeNull();
    expect(resolveSuggestedMinistry("999 Slush Fund")).toBeNull();
    expect(resolveSuggestedMinistry("   ")).toBeNull();
    expect(resolveSuggestedMinistry(null)).toBeNull();
  });
});

describe("parseSuggestionResponse", () => {
  it("parses a plain JSON answer", () => {
    expect(
      parseSuggestionResponse(
        '{"ministry": "470 Summer Retreat", "event": "Summer Retreat", "rationale": "retreat"}'
      )
    ).toEqual({ ministry: "470 Summer Retreat", event: "Summer Retreat", rationale: "retreat" });
  });

  it("tolerates markdown fences and prose, like the extraction parser", () => {
    const text = 'Sure!\n```json\n{"ministry": "320 VBS", "event": null, "rationale": "kids"}\n```';
    expect(parseSuggestionResponse(text)).toEqual({
      ministry: "320 VBS",
      event: null,
      rationale: "kids",
    });
  });

  it("coerces an unknown ministry to null instead of inventing a category", () => {
    const parsed = parseSuggestionResponse(
      '{"ministry": "Youth Stuff", "event": "Retreat", "rationale": "guess"}'
    );
    expect(parsed.ministry).toBeNull();
    expect(parsed.event).toBe("Retreat");
  });

  it("normalizes blank events to null", () => {
    expect(
      parseSuggestionResponse('{"ministry": "320 VBS", "event": "  ", "rationale": ""}').event
    ).toBeNull();
  });

  it("rejects a response without JSON", () => {
    expect(() => parseSuggestionResponse("I could not decide.")).toThrow(/JSON/);
  });
});

describe("mockSuggest (AI_MOCK fixtures — e2e depends on these exact rules)", () => {
  it("youth + retreat → Youth Retreat", () => {
    expect(mockSuggest("Snacks for the Youth Retreat").ministry).toBe("471 Youth Retreat");
  });

  it("retreat alone → Summer Retreat with an event label", () => {
    expect(mockSuggest("gas for the retreat")).toMatchObject({
      ministry: "470 Summer Retreat",
      event: "Summer Retreat",
    });
  });

  it("office → Office Supplies, no event", () => {
    expect(mockSuggest("printer paper for the office")).toMatchObject({
      ministry: "237 Office Supplies",
      event: null,
    });
  });

  it("no keyword → null (the 'no confident match' path)", () => {
    expect(mockSuggest("miscellaneous unmatchable things").ministry).toBeNull();
    expect(mockSuggest("random purchase").ministry).toBeNull();
  });
});

describe("suggestMinistryEvent with AI_MOCK=1", () => {
  afterEach(() => {
    delete process.env.AI_MOCK;
  });

  it("returns the mock suggestion plus loggable metadata without any network call", async () => {
    process.env.AI_MOCK = "1";
    const { suggestion, meta } = await suggestMinistryEvent("supplies for the youth retreat");
    expect(suggestion.ministry).toBe("471 Youth Retreat");
    expect(meta.model).toBe("mock");
    expect(meta.prompt).toContain("youth retreat");
    expect(meta.rawResponse).toBe(JSON.stringify(suggestion));
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);
  });
});
