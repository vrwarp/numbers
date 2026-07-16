import { afterEach, describe, expect, it } from "vitest";
import {
  buildCandidatesPrompt,
  buildSuggestionPrompt,
  mockSuggest,
  mockSuggestCandidates,
  parseCandidatesResponse,
  parseSuggestionResponse,
  resolveSuggestedMinistry,
  suggestMinistryCandidates,
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

  it("appends each category's configurable description to its line", () => {
    const prompt = buildSuggestionPrompt("gas for the retreat", null, [
      { value: "470 Summer Retreat", description: "Adult all-church summer camp" },
      { value: "471 Youth Retreat" },
    ]);
    expect(prompt).toContain("- 470 Summer Retreat — Adult all-church summer camp");
    // A category with no description keeps its bare bullet.
    expect(prompt).toContain("- 471 Youth Retreat\n");
    expect(prompt).not.toContain("471 Youth Retreat —");
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

describe("buildCandidatesPrompt", () => {
  it("lists every category, the description, and asks for a JSON candidates array", () => {
    const prompt = buildCandidatesPrompt("supplies for the retreat", null);
    for (const m of MINISTRIES) expect(prompt).toContain(m);
    expect(prompt).toContain('"supplies for the retreat"');
    expect(prompt).toContain('"candidates"');
    expect(prompt).not.toContain("rejected all of them");
  });

  it("adds the rejected list and extra detail on the terminal follow-up", () => {
    const prompt = buildCandidatesPrompt("supplies for the retreat", null, {
      more: "it was VBS, not a retreat",
      rejected: ["470 Summer Retreat", "471 Youth Retreat"],
    });
    expect(prompt).toContain("rejected all of them");
    expect(prompt).toContain("470 Summer Retreat");
    expect(prompt).toContain("it was VBS, not a retreat");
  });

  it("appends each category's configurable description to its line", () => {
    const prompt = buildCandidatesPrompt("supplies for the retreat", null, undefined, [
      { value: "320 VBS", description: "Vacation Bible School — summer kids week" },
      { value: "237 Office Supplies" },
    ]);
    expect(prompt).toContain("- 320 VBS — Vacation Bible School — summer kids week");
    expect(prompt).toContain("- 237 Office Supplies\n");
    expect(prompt).not.toContain("237 Office Supplies —");
  });
});

describe("parseCandidatesResponse", () => {
  it("resolves each candidate and keeps ranking order", () => {
    const out = parseCandidatesResponse(
      '{"candidates":[{"ministry":"470 Summer Retreat","event":"Retreat","rationale":"a"},{"ministry":"471 youth retreat","event":null,"rationale":"b"}]}'
    );
    expect(out).toEqual([
      { ministry: "470 Summer Retreat", event: "Retreat", rationale: "a" },
      { ministry: "471 Youth Retreat", event: null, rationale: "b" },
    ]);
  });

  it("drops unresolvable candidates rather than inventing categories", () => {
    const out = parseCandidatesResponse(
      '{"candidates":[{"ministry":"Made Up Fund","event":null,"rationale":"x"},{"ministry":"320 VBS","event":"VBS","rationale":"y"}]}'
    );
    expect(out).toEqual([{ ministry: "320 VBS", event: "VBS", rationale: "y" }]);
  });

  it("dedupes identical pairings and caps at three", () => {
    const out = parseCandidatesResponse(
      '{"candidates":[' +
        '{"ministry":"320 VBS","event":"VBS","rationale":"1"},' +
        '{"ministry":"320 VBS","event":"VBS","rationale":"dup"},' +
        '{"ministry":"237 Office Supplies","event":null,"rationale":"2"},' +
        '{"ministry":"470 Summer Retreat","event":null,"rationale":"3"},' +
        '{"ministry":"471 Youth Retreat","event":null,"rationale":"4"}]}'
    );
    expect(out.map((c) => c.ministry)).toEqual([
      "320 VBS",
      "237 Office Supplies",
      "470 Summer Retreat",
    ]);
  });

  it("returns an empty list for an empty or matchless response", () => {
    expect(parseCandidatesResponse('{"candidates":[]}')).toEqual([]);
    expect(
      parseCandidatesResponse('{"candidates":[{"ministry":null,"event":null,"rationale":""}]}')
    ).toEqual([]);
  });
});

describe("mockSuggestCandidates (AI_MOCK fixtures — walkthrough & e2e depend on these)", () => {
  it("youth + retreat → a single confident candidate", () => {
    expect(mockSuggestCandidates("Snacks for the youth retreat")).toEqual([
      { ministry: "471 Youth Retreat", event: "Youth Retreat", rationale: "Mock: youth retreat." },
    ]);
  });

  it("retreat alone → three ambiguous budget lines to disambiguate", () => {
    const out = mockSuggestCandidates("supplies for the retreat");
    expect(out.map((c) => c.ministry)).toEqual([
      "470 Summer Retreat",
      "471 Youth Retreat",
      "481 TRANSPARENT Retreat",
    ]);
  });

  it("the follow-up detail steers the second turn (something else → VBS)", () => {
    expect(mockSuggestCandidates("supplies for the retreat", "it was VBS, not a retreat")).toEqual([
      { ministry: "320 VBS", event: "VBS", rationale: "Mock: VBS." },
    ]);
  });

  it("no keyword → empty (the 'no confident match' path)", () => {
    expect(mockSuggestCandidates("miscellaneous unmatchable things")).toEqual([]);
  });
});

describe("suggestMinistryCandidates with AI_MOCK=1", () => {
  afterEach(() => {
    delete process.env.AI_MOCK;
  });

  it("returns the mock candidates plus loggable metadata without any network call", async () => {
    process.env.AI_MOCK = "1";
    const { candidates, meta } = await suggestMinistryCandidates("supplies for the retreat");
    expect(candidates).toHaveLength(3);
    expect(meta.model).toBe("mock");
    expect(meta.rawResponse).toBe(JSON.stringify({ candidates }));
  });
});
