import { templatePath } from "./redact";

/**
 * Sensitive-surface policy (docs/FEEDBACK_DESIGN.md §5 / V4). On these routes a
 * report captures — or a screenshot would capture — ANOTHER member's data
 * (approver identities, decisions, signature material, the directory), which the
 * reporter must not exfiltrate even to an admin. On a sensitive route the
 * feedback flow: discloses it, (when screenshots ship) hard-disables capture,
 * and keeps breadcrumbs to route templates only. Route-based and pure —
 * client-safe and unit-tested. The in-claim e-sign ceremony is a dialog, not a
 * route, so it can't be caught here; screenshots being opt-in + previewed +
 * absent in this slice is the backstop.
 */
const SENSITIVE_PREFIXES = [
  "/approvals",
  "/finance",
  "/members",
  "/vouch",
  "/v/", // public verification of a signed packet
  "/c/", // QR capability link
];

export function isSensitiveRoute(pathname: string): boolean {
  const p = (pathname || "/").split("?")[0];
  return SENSITIVE_PREFIXES.some((prefix) =>
    prefix.endsWith("/") ? p.startsWith(prefix) : p === prefix || p.startsWith(prefix + "/")
  );
}

/** The redacted route template for the current location (drops ids/query). */
export function routeTemplate(pathname: string): string {
  return templatePath(pathname || "/");
}
