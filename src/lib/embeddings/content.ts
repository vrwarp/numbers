import { createHash } from "crypto";
import { centsToDollarString } from "@/lib/money";
import { formatMonthMMYYYY, zonedYear } from "@/lib/timezone";

/**
 * Pure builders for embedding inputs and staleness fingerprints
 * (docs/SEARCH_DESIGN.md §4/§5.1). Everything here is deterministic data → the
 * daily reconcile sweep rebuilds these from DB columns only and compares.
 * Calendar reads (year buckets, the composite's MM/YYYY) take the app time
 * zone explicitly (callers pass appTimeZone()) — changing TIME_ZONE therefore
 * shifts some fingerprints, and the normal staleness sweep re-embeds exactly
 * the affected rows.
 */

export const COMPOSITE_BYTE_BUDGET = 4000;

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// --- Receipts -----------------------------------------------------------------

export type ReceiptContent = {
  fileSha256: string;
  note: string;
  merchant: string;
  // AI-extracted item summary (e.g. "rulers, duct tape, clothespins"), stamped
  // by the background annotation worker; "" until then. The richest AI detail
  // for semantic search, so it rides in the prompt text + fingerprint — a
  // re-annotation that rewrites it re-embeds (§5.1). Printed totals and the
  // transcribed date are deliberately NOT embedded: amounts belong to the
  // exact-match pass (§6.2), not the semantic vector.
  extractedSummary: string;
  // Not embedded, but kept in the fingerprint: it feeds the year bucket
  // (receiptYear), so a date change must re-embed to re-stamp the year column.
  purchaseDate: string;
  createdAt: Date;
};

/** Fingerprint of the FULL receipt embedding input (image bytes + paired text)
 *  plus the year key's source, so any change re-embeds. Covers the AI-extracted
 *  text that rides in the prompt (merchant, item summary), the user's own note,
 *  and purchaseDate (the year bucket's source). */
export function receiptFingerprint(r: ReceiptContent): string {
  return sha256Hex(
    [r.fileSha256, r.note, r.merchant, r.extractedSummary, r.purchaseDate].join("␟")
  );
}

/** The text paired with the image pixels in prompt_string (§5.1): the AI-
 *  extracted merchant + item summary plus the user's own note/description. */
export function receiptPromptText(
  r: Pick<ReceiptContent, "note" | "merchant" | "extractedSummary">
): string {
  const parts = ["A photographed purchase receipt."];
  if (r.merchant) parts.push(`Merchant: ${r.merchant}.`);
  if (r.extractedSummary) parts.push(`Items: ${r.extractedSummary}.`);
  if (r.note) parts.push(`User note: ${r.note}.`);
  return parts.join(" ");
}

/** Year bucket: purchaseDate transcription prefix when date-like (a substring
 *  read, timezone-free), else the upload instant's year in the app zone. */
export function receiptYear(
  r: Pick<ReceiptContent, "purchaseDate" | "createdAt">,
  timeZone: string
): number {
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(r.purchaseDate);
  if (m) {
    const y = Number(m[1]);
    if (y >= 1990 && y <= 2100) return y;
  }
  return zonedYear(r.createdAt, timeZone);
}

// --- Claims ---------------------------------------------------------------------

export type ClaimContent = {
  ownerName: string; // fullName || email
  claimDescription: string;
  lineItems: {
    description: string;
    amountCents: number;
    ministry: string;
    event: string;
    isExcluded: boolean;
  }[];
  merchants: string[]; // distinct receipt merchants, non-empty
  totalCents: number;
  createdAt: Date;
  submittedAt: Date | null;
};

function formatMinistryEventLocal(ministry: string, event: string): string {
  if (!ministry) return event;
  return event ? `${ministry} — ${event}` : ministry;
}

/**
 * The claim's embedding input: a structured text composite of its content —
 * never the rasterized form page, which is 90% identical template boilerplate.
 * Capped at COMPOSITE_BYTE_BUDGET UTF-8 bytes (server context math, §3.1):
 * the items list truncates with an "… and N more items" tail.
 */
export function buildClaimComposite(c: ClaimContent, timeZone: string): string {
  const active = c.lineItems.filter((i) => !i.isExcluded);
  const ministries = [
    ...new Set(
      active.map((i) => formatMinistryEventLocal(i.ministry, i.event)).filter(Boolean)
    ),
  ];
  const mmYyyy = formatMonthMMYYYY(c.submittedAt ?? c.createdAt, timeZone);

  const head =
    `Reimbursement claim by ${c.ownerName}.` +
    (c.claimDescription ? ` ${c.claimDescription}.` : "") +
    (ministries.length ? ` Ministries: ${ministries.join("; ")}.` : "");
  const tail =
    (c.merchants.length ? ` Merchants: ${[...new Set(c.merchants)].join(", ")}.` : "") +
    ` Total $${centsToDollarString(c.totalCents)}. ${mmYyyy}.`;

  const items = active.map(
    (i) => `${i.description} ($${centsToDollarString(i.amountCents)})`
  );
  const fixedBytes = Buffer.byteLength(head + " Items: ." + tail, "utf8");
  let budget = COMPOSITE_BYTE_BUDGET - fixedBytes;
  const kept: string[] = [];
  for (const item of items) {
    const cost = Buffer.byteLength(item + "; ", "utf8");
    if (cost > budget) break;
    kept.push(item);
    budget -= cost;
  }
  const omitted = items.length - kept.length;
  const itemsPart = kept.length
    ? ` Items: ${kept.join("; ")}${omitted > 0 ? `; … and ${omitted} more items` : ""}.`
    : "";
  return head + itemsPart + tail;
}

export function claimFingerprint(c: ClaimContent, timeZone: string): string {
  return sha256Hex(buildClaimComposite(c, timeZone));
}

export function claimYear(
  c: Pick<ClaimContent, "createdAt" | "submittedAt">,
  timeZone: string
): number {
  return zonedYear(c.submittedAt ?? c.createdAt, timeZone);
}
