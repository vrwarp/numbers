/**
 * Field-level diffs for the review-edit audit trail. Each AuditEvent stores
 * {"changes": {field: {from, to}}} so prompt tuning can see exactly which
 * AI-extracted values humans had to correct.
 */

export type FieldChange = { from: unknown; to: unknown };
export type ChangeSet = Record<string, FieldChange>;

const TRACKED_FIELDS = [
  "description",
  "amountCents",
  "ministry",
  "event",
  "isVerified",
  "isExcluded",
] as const;

type Trackable = Partial<Record<(typeof TRACKED_FIELDS)[number], unknown>>;

/** Compare a line item against a patch; returns only fields that actually change. */
export function computeLineItemChanges(before: Trackable, patch: Trackable): ChangeSet {
  const changes: ChangeSet = {};
  for (const field of TRACKED_FIELDS) {
    if (patch[field] !== undefined && patch[field] !== before[field]) {
      changes[field] = { from: before[field], to: patch[field] };
    }
  }
  return changes;
}
