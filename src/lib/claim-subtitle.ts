/**
 * The one-line subtitle for a claim summary row (approver inbox, finance queue).
 * Pure so it's unit-testable and shared by the row component.
 */

export interface ClaimSubtitleInput {
  claimDescription: string;
  rows: { event: string }[];
}

/**
 * The subtitle: the owner's authored description when there is one, otherwise
 * the distinct events the claim spans (deduped, first-seen order, joined with
 * commas — the truncating container clips overflow with a CSS ellipsis). Only
 * when no row carries an event does it fall back to a plain item count.
 */
export function claimSubtitle(
  c: ClaimSubtitleInput,
  itemsFallback: (count: number) => string
): string {
  if (c.claimDescription) return c.claimDescription;
  const events: string[] = [];
  for (const r of c.rows) {
    const e = r.event.trim();
    if (e && !events.includes(e)) events.push(e);
  }
  if (events.length) return events.join(", ");
  return itemsFallback(c.rows.length);
}
