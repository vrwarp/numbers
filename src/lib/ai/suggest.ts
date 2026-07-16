import { z } from "zod";
import { isAiMock } from "@/lib/config";
import { MINISTRIES } from "@/lib/ministries";
import { loadActiveMinistryValues } from "@/lib/ministries-catalog";
import { loadChurchContext } from "@/lib/church-context";
import { extractJsonObject } from "./parse";
import {
  callProvider,
  currentProvider,
  providerApiKey,
  providerModel,
  ProviderCallError,
  type AiProvider,
} from "./providers";
import { acquireRateSlot } from "./throttle";

/**
 * Text-only "what ministry/event is this claim for?" call. The user types one
 * sentence; the model picks a budget category from the chart of accounts
 * (verbatim, or null when nothing fits) plus an optional short event label,
 * guided by the operator's church-context document when one exists.
 *
 * This is a SUGGESTION, never an assignment: the route returns it to the UI,
 * where the human applies it (or doesn't). Nothing here touches line items or
 * verification — the human-in-the-loop gate is unaffected.
 */

export interface MinistrySuggestion {
  /** A MINISTRIES entry verbatim, or null when the model isn't confident. */
  ministry: string | null;
  event: string | null;
  rationale: string;
}

/** Call metadata persisted to the ExtractionLog (kind "suggestion"). */
export interface SuggestionMeta {
  model: string;
  prompt: string;
  rawResponse: string | null;
  durationMs: number;
}

/** Thrown when the suggestion call fails; carries the metadata for logging. */
export class SuggestionError extends Error {
  constructor(message: string, public meta: SuggestionMeta, public quota = false) {
    super(message);
  }
}

const ModelSuggestionSchema = z.object({
  ministry: z.string().nullable(),
  event: z.string().max(100).nullable().default(null),
  rationale: z.string().max(500).default(""),
});

export function buildSuggestionPrompt(
  description: string,
  churchContext: string | null,
  ministries: readonly string[] = MINISTRIES
): string {
  const contextBlock = churchContext
    ? `\nChurch-specific context (group names, recurring events, labeling rules):\n---\n${churchContext}\n---\n`
    : "";
  return `You are helping a church member label a reimbursement claim.

The church tracks expenses against this chart of accounts. These are the ONLY valid budget categories:
${ministries.map((m) => `- ${m}`).join("\n")}
${contextBlock}
The member describes what the whole claim is for:
"${description}"

Pick the single best-matching budget category, and — only when the description points at a specific event or activity — a short event label (e.g. "Summer Retreat", "Christmas Party"). If no category clearly fits, use null rather than guessing.

Respond with ONLY a JSON object (no markdown, no commentary):
{"ministry": "<one budget category from the list, copied verbatim, or null>", "event": "<short event label or null>", "rationale": "<one sentence explaining the choice>"}`;
}

/**
 * Map whatever the model wrote in "ministry" onto a real MINISTRIES entry:
 * exact match, then case-insensitive, then by leading account number ("470"
 * or "470 Retreat" → "470 Summer Retreat"). Null when nothing matches — the
 * UI tells the user to pick manually rather than showing a made-up category.
 */
export function resolveSuggestedMinistry(
  value: string | null,
  ministries: readonly string[] = MINISTRIES
): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  const exact = ministries.find((m) => m === v);
  if (exact) return exact;
  const insensitive = ministries.find((m) => m.toLowerCase() === v.toLowerCase());
  if (insensitive) return insensitive;
  const number = v.match(/^(\d{3})\b/)?.[1];
  if (number) {
    const byNumber = ministries.find((m) => m.startsWith(`${number} `));
    if (byNumber) return byNumber;
  }
  return null;
}

export function parseSuggestionResponse(
  text: string,
  ministries: readonly string[] = MINISTRIES
): MinistrySuggestion {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonObject(text));
  } catch {
    throw new Error("AI response did not contain valid JSON");
  }
  const parsed = ModelSuggestionSchema.parse(raw);
  const ministry = resolveSuggestedMinistry(parsed.ministry, ministries);
  return {
    ministry,
    event: parsed.event?.trim() || null,
    rationale: parsed.rationale.trim(),
  };
}

/* ----------------------------------------------------------------------------
 * Candidate suggestions (the review panel's AI zone).
 *
 * Instead of one best guess, the model returns up to THREE ranked, already-
 * resolved (ministry, event) pairings. The UI renders them as a pick-list —
 * tapping one applies it with no further model call. Only when the user
 * rejects them all ("Something else…") do we call again, this time with their
 * extra detail (`refine`); that second call is terminal. length === 1 is the
 * "confident" case and renders exactly like the old single suggestion.
 * ------------------------------------------------------------------------- */

/** A resolved candidate: `ministry` is always a real MINISTRIES entry. */
export interface MinistryCandidate {
  ministry: string;
  event: string | null;
  rationale: string;
}

export interface CandidatesResult {
  candidates: MinistryCandidate[];
  meta: SuggestionMeta;
}

/** Extra context for the terminal follow-up call after "Something else…". */
export interface CandidateRefine {
  more: string;
  rejected: string[];
}

const MAX_CANDIDATES = 3;

const ModelCandidatesSchema = z.object({
  candidates: z
    .array(
      z.object({
        ministry: z.string().nullable(),
        event: z.string().max(100).nullable().default(null),
        rationale: z.string().max(500).default(""),
      })
    )
    .default([]),
});

export function buildCandidatesPrompt(
  description: string,
  churchContext: string | null,
  refine?: CandidateRefine,
  ministries: readonly string[] = MINISTRIES
): string {
  const contextBlock = churchContext
    ? `\nChurch-specific context (group names, recurring events, labeling rules):\n---\n${churchContext}\n---\n`
    : "";
  const refineBlock = refine
    ? `\nThe member already saw these categories and rejected all of them: ${
        refine.rejected.length ? refine.rejected.map((r) => `"${r}"`).join(", ") : "(none)"
      }.\nThey added this clarifying detail:\n"${refine.more}"\nUse it to choose the best category now — do not repeat the rejected ones unless the new detail makes one clearly correct.\n`
    : "";
  return `You are helping a church member label a reimbursement claim.

The church tracks expenses against this chart of accounts. These are the ONLY valid budget categories:
${ministries.map((m) => `- ${m}`).join("\n")}
${contextBlock}
The member describes what the whole claim is for:
"${description}"
${refineBlock}
Return the ${MAX_CANDIDATES} best-matching budget categories at most, ranked best first. If one clearly fits, return just that one. If two or three are plausible, return them so the member can choose. If none fit, return an empty list rather than guessing. For each, add a short event label ONLY when the description points at a specific event or activity (e.g. "Summer Retreat"), otherwise null.

Respond with ONLY a JSON object (no markdown, no commentary):
{"candidates": [{"ministry": "<one budget category from the list, copied verbatim>", "event": "<short event label or null>", "rationale": "<one short sentence>"}]}`;
}

/**
 * Parse the model's candidate list: resolve each ministry against the known
 * list (dropping anything that doesn't map — a tap must never apply an
 * off-list category), drop duplicates, and cap at MAX_CANDIDATES.
 */
export function parseCandidatesResponse(
  text: string,
  ministries: readonly string[] = MINISTRIES
): MinistryCandidate[] {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonObject(text));
  } catch {
    throw new Error("AI response did not contain valid JSON");
  }
  const parsed = ModelCandidatesSchema.parse(raw);
  const out: MinistryCandidate[] = [];
  const seen = new Set<string>();
  for (const c of parsed.candidates) {
    const ministry = resolveSuggestedMinistry(c.ministry, ministries);
    if (!ministry) continue;
    const event = c.event?.trim() || null;
    const key = `${ministry} ${event ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ministry, event, rationale: c.rationale.trim() });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/**
 * Deterministic candidates for AI_MOCK=1 (tests, offline dev, the walkthrough).
 * Keys on description (+ the follow-up detail) so the pick-list, the confident
 * single, the "no match" and the "something else" paths are all reproducible.
 */
export function mockSuggestCandidates(description: string, more?: string): MinistryCandidate[] {
  const d = `${description} ${more ?? ""}`.toLowerCase();
  if (d.includes("unmatchable") || d.includes("random")) return [];
  if (d.includes("vbs")) {
    return [{ ministry: "320 VBS", event: "VBS", rationale: "Mock: VBS." }];
  }
  if (d.includes("youth") && d.includes("retreat")) {
    return [{ ministry: "471 Youth Retreat", event: "Youth Retreat", rationale: "Mock: youth retreat." }];
  }
  if (d.includes("retreat")) {
    return [
      { ministry: "470 Summer Retreat", event: "Retreat", rationale: "Mock: could be the summer retreat." },
      { ministry: "471 Youth Retreat", event: "Retreat", rationale: "Mock: could be the youth retreat." },
      { ministry: "481 TRANSPARENT Retreat", event: "Retreat", rationale: "Mock: could be the TRANSPARENT retreat." },
    ];
  }
  if (d.includes("office") || d.includes("supplies")) {
    return [{ ministry: "237 Office Supplies", event: null, rationale: "Mock: office supplies." }];
  }
  return [];
}

/**
 * One candidate call. Mirrors suggestMinistryEvent's provider plumbing (no
 * cooldown retry — the user is waiting on a click) but returns a ranked list.
 */
export async function suggestMinistryCandidates(
  description: string,
  refine?: CandidateRefine
): Promise<CandidatesResult> {
  const churchContext = await loadChurchContext();

  // Mock mode is fully offline: the candidates are deterministic and the
  // logged prompt only needs the built-in list, so we skip the catalog read
  // (Prisma) entirely — the unit suite runs without a DATABASE_URL.
  if (isAiMock()) {
    const prompt = buildCandidatesPrompt(description, churchContext, refine);
    const started = Date.now();
    const candidates = mockSuggestCandidates(description, refine?.more);
    return {
      candidates,
      meta: {
        model: "mock",
        prompt,
        rawResponse: JSON.stringify({ candidates }),
        durationMs: Date.now() - started,
      },
    };
  }

  const ministries = await loadActiveMinistryValues();
  const prompt = buildCandidatesPrompt(description, churchContext, refine, ministries);
  const started = Date.now();

  let model = "unknown";
  const failMeta = (rawResponse: string | null): SuggestionMeta => ({
    model,
    prompt,
    rawResponse,
    durationMs: Date.now() - started,
  });

  let provider: AiProvider;
  let apiKey: string;
  try {
    provider = currentProvider();
    model = providerModel(provider);
    apiKey = providerApiKey(provider);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI provider misconfigured";
    throw new SuggestionError(msg, failMeta(null));
  }

  let text: string;
  try {
    await acquireRateSlot();
    text = await callProvider(provider, apiKey, model, prompt);
  } catch (err) {
    if (err instanceof ProviderCallError) {
      throw new SuggestionError(err.message, failMeta(err.rawResponse), err.status === 429);
    }
    const msg = err instanceof Error ? err.message : "suggestion failed";
    throw new SuggestionError(msg, failMeta(null));
  }

  let candidates: MinistryCandidate[];
  try {
    candidates = parseCandidatesResponse(text, ministries);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "parse error";
    throw new SuggestionError(msg, failMeta(text));
  }

  return { candidates, meta: { model, prompt, rawResponse: text, durationMs: Date.now() - started } };
}

/**
 * Deterministic suggestion used when AI_MOCK=1 (tests, offline dev) — keyword
 * rules over the description, mirroring how mockExtract keys on file names.
 */
export function mockSuggest(description: string): MinistrySuggestion {
  const d = description.toLowerCase();
  if (d.includes("unmatchable")) {
    return { ministry: null, event: null, rationale: "Mock: nothing in the budget list fits." };
  }
  if (d.includes("youth") && d.includes("retreat")) {
    return { ministry: "471 Youth Retreat", event: "Youth Retreat", rationale: "Mock: youth retreat." };
  }
  if (d.includes("retreat")) {
    return { ministry: "470 Summer Retreat", event: "Summer Retreat", rationale: "Mock: retreat." };
  }
  if (d.includes("office")) {
    return { ministry: "237 Office Supplies", event: null, rationale: "Mock: office supplies." };
  }
  return { ministry: null, event: null, rationale: "Mock: no confident match." };
}

/**
 * One suggestion call: build the prompt (chart of accounts + church context +
 * the user's sentence), call the provider text-only, and validate the answer
 * against the known ministry list. Unlike extraction there is no cooldown
 * retry — the user is waiting on a button click, so a quota rejection
 * surfaces immediately (SuggestionError.quota) instead of stalling the UI.
 */
export async function suggestMinistryEvent(
  description: string
): Promise<{ suggestion: MinistrySuggestion; meta: SuggestionMeta }> {
  const churchContext = await loadChurchContext();

  // Mock mode is fully offline: the suggestion is deterministic and the logged
  // prompt only needs the built-in list, so we skip the catalog read (Prisma)
  // entirely — the unit suite runs without a DATABASE_URL.
  if (isAiMock()) {
    const prompt = buildSuggestionPrompt(description, churchContext);
    const started = Date.now();
    const suggestion = mockSuggest(description);
    return {
      suggestion,
      meta: {
        model: "mock",
        prompt,
        rawResponse: JSON.stringify(suggestion),
        durationMs: Date.now() - started,
      },
    };
  }

  const ministries = await loadActiveMinistryValues();
  const prompt = buildSuggestionPrompt(description, churchContext, ministries);
  const started = Date.now();

  let model = "unknown";
  const failMeta = (rawResponse: string | null): SuggestionMeta => ({
    model,
    prompt,
    rawResponse,
    durationMs: Date.now() - started,
  });

  let provider: AiProvider;
  let apiKey: string;
  try {
    provider = currentProvider();
    model = providerModel(provider);
    apiKey = providerApiKey(provider);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI provider misconfigured";
    throw new SuggestionError(msg, failMeta(null));
  }

  let text: string;
  try {
    await acquireRateSlot();
    text = await callProvider(provider, apiKey, model, prompt);
  } catch (err) {
    if (err instanceof ProviderCallError) {
      throw new SuggestionError(err.message, failMeta(err.rawResponse), err.status === 429);
    }
    const msg = err instanceof Error ? err.message : "suggestion failed";
    throw new SuggestionError(msg, failMeta(null));
  }

  let suggestion: MinistrySuggestion;
  try {
    suggestion = parseSuggestionResponse(text, ministries);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "parse error";
    throw new SuggestionError(msg, failMeta(text));
  }

  return { suggestion, meta: { model, prompt, rawResponse: text, durationMs: Date.now() - started } };
}
