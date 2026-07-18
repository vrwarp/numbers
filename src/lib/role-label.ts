/**
 * The roles that have a `Common.role.*` label — display order matches rising
 * capability. Shared by every component that renders a role tag so a new role
 * (e.g. chairman/secretary) can't silently fall back to its raw value in one
 * screen but not another.
 */
export const ROLE_LABEL_KEYS = [
  "member",
  "approver",
  "secretary",
  "chairman",
  "treasurer",
  "admin",
] as const;

export type RoleLabelKey = (typeof ROLE_LABEL_KEYS)[number];

/** The `Common.role` message key for a mirror role, or undefined for values
 *  without a label (callers fall back to the raw string). */
export function roleLabelKey(role: string): RoleLabelKey | undefined {
  return ROLE_LABEL_KEYS.find((r) => r === role);
}
