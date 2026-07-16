/**
 * Shared helpers for the translation pipeline: the parity/staleness unit test
 * and scripts/translate-messages.ts must agree on flattening and ICU-argument
 * extraction, so they live here (pure functions, no fs).
 */

export type Messages = { [key: string]: string | Messages };

export type TranslationStatus = "todo" | "machine" | "reviewed";

/**
 * One entry per key in messages/translation-state.json. `source` is the
 * verbatim English the translations were made from — kept as readable text
 * (not a hash) so an entry is self-contained: key, English, translator hint,
 * and per-locale review status all read together. Staleness is simply
 * `entry.source !== en.json's current value`.
 */
export interface StateEntry {
  source: string;
  /** Optional translator note (what/where the string is) fed into drafting prompts. */
  context?: string;
  "zh-Hans"?: TranslationStatus;
  "zh-Hant"?: TranslationStatus;
}

export type TranslationState = Record<string, StateEntry>;

/**
 * Cross-key wording dependencies, made first-class instead of prose hints so
 * they can't drift: the parity test enforces both kinds in EVERY locale, and
 * scripts/translate-messages.ts uses them to draft in dependency order.
 */

/**
 * Keys that must render IDENTICALLY (the same UI element appearing in more
 * than one place). The first key is canonical: it is the one translated;
 * the script copies its value onto the rest.
 */
export const SAME_VALUE_GROUPS: readonly (readonly string[])[] = [
  ["Search.title", "NavBar.search", "Search.searchButton"],
  ["Shoebox.title", "NavBar.shoebox"],
  ["Claims.title", "NavBar.claims"],
  ["Profile.title", "NavBar.profile"],
  ["Shoebox.upload", "AddReceipts.upload"],
  ["Shoebox.uploading", "AddReceipts.uploading"],
  ["Shoebox.uploadFailed", "AddReceipts.uploadFailed"],
  ["Shoebox.manualInstead", "AddReceipts.manualInstead"],
  ["Shoebox.readingInitial", "AddReceipts.readingInitial"],
  ["Shoebox.readingCount", "AddReceipts.readingCount"],
  ["Shoebox.readProgress", "AddReceipts.readProgress"],
  ["Review.editPhotoButton", "Viewer.editButton"],
  ["Viewer.rendering", "PdfPreview.rendering"],
  // E-sign: the nav links repeat the page titles; the status word must be the
  // same everywhere a claim's state is named (list chip, panel heading,
  // signature-block title, finance section header, /v thread lines).
  ["Approvals.title", "NavBar.approvals"],
  ["Finance.title", "NavBar.finance"],
  ["Common.status.submitted", "Esign.panelSubmitted"],
  ["Common.status.approved", "Esign.blockApproved", "Verify.approved"],
  ["Common.status.rejected", "Esign.blockRejected", "Verify.rejected"],
  ["Common.status.paid", "Esign.panelPaid", "Esign.blockPaid", "Finance.paidHeader", "Verify.paid"],
  // The duty rows reuse the master switch's on/off button wording.
  ["Identity.turnOn", "Profile.dutyTurnOn"],
  ["Identity.turnOff", "Profile.dutyTurnOff"],
];

/**
 * Messages that quote another UI element's wording inside a sentence. The
 * quoted key's value (minus `strip`, e.g. a leading emoji that isn't spoken
 * of in prose) must appear verbatim inside the message, in every locale.
 */
export const QUOTED_IN: readonly { message: string; quotes: string; strip?: string }[] = [
  { message: "Claims.emptyBody", quotes: "Shoebox.newClaim", strip: "✨ " },
  { message: "Shoebox.step2", quotes: "Shoebox.newClaim", strip: "✨ " },
  { message: "Review.multiHint", quotes: "Review.modeOne" },
  { message: "Review.revertConfirm", quotes: "Common.status.processed" },
  // E-sign: dialog/page titles restate the button that opened them (minus
  // the button's emoji prefix).
  { message: "Esign.submitDialogTitle", quotes: "Esign.submitForApproval", strip: "✍️ " },
  // The pending-QR instructions name the nav tab the voucher must open.
  { message: "Identity.pendingVouch", quotes: "NavBar.vouch" },
];

export function flatten(obj: Messages, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(full, value);
    else for (const [k, v] of flatten(value, full)) out.set(k, v);
  }
  return out;
}

/** Rebuild the nested catalog shape from a flat map, following en's key order. */
export function unflatten(flat: Map<string, string>, order: string[]): Messages {
  const out: Messages = {};
  for (const key of order) {
    const value = flat.get(key);
    if (value === undefined) continue;
    const parts = key.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) {
      node = (node[part] ??= {}) as Messages;
    }
    node[parts[parts.length - 1]] = value;
  }
  return out;
}

/** ICU argument names ({count}, {merchant, plural, …}) + rich tags (<link>). */
export function messageArguments(message: string): string[] {
  const args = new Set<string>();
  for (const m of message.matchAll(/\{\s*([a-zA-Z0-9_]+)\s*[,}]/g)) args.add(`{${m[1]}}`);
  for (const m of message.matchAll(/<([a-z][a-zA-Z0-9]*)>/g)) args.add(`<${m[1]}>`);
  return [...args].sort();
}
