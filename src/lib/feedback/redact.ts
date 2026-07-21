/**
 * Redaction primitives for the feedback capture bundle (docs/FEEDBACK_DESIGN.md
 * §3). Dependency-free and pure so they are client-safe and unit-tested — the
 * privacy boundary lives here, not in prose. The rule: breadcrumbs and route
 * labels store SHAPES, never values. A path keeps its structure and its
 * dynamic segments collapse to placeholders; free text (error messages the user
 * never chose the wording of) gets money-like runs scrubbed and a hard length
 * cap. Nothing here ever emits an amount, a description, a token, or a name.
 */

// A cuid (Prisma's default id): starts with "c", then base36. publicToken /
// e-sign tokens are long base64url. Numeric ids and uuids also collapse.
const CUID = /^c[a-z0-9]{14,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEXISH = /^[0-9a-f]{16,}$/i;

/**
 * Collapse a URL or pathname to a route TEMPLATE — origin and query dropped,
 * every id-shaped segment replaced. `/claims/ckz9…` → `/claims/[id]`,
 * `/api/reimbursements/ckz9…/pdf` → `/api/reimbursements/[id]/pdf`,
 * `/c/AbCd…64url` → `/c/[token]`.
 */
export function templatePath(input: string): string {
  let path = input;
  // Strip an absolute origin if one slipped in (fetch URLs may be absolute).
  const schemeIdx = path.indexOf("://");
  if (schemeIdx !== -1) {
    const rest = path.slice(schemeIdx + 3);
    const slash = rest.indexOf("/");
    path = slash === -1 ? "/" : rest.slice(slash);
  }
  path = path.split("?")[0].split("#")[0];
  const segments = path.split("/").filter(Boolean).map((seg) => {
    if (CUID.test(seg)) return "[id]";
    if (UUID.test(seg)) return "[id]";
    if (/^\d+$/.test(seg)) return "[n]";
    // Long opaque tokens (publicToken / e-sign links / base64url blobs).
    if (seg.length >= 20 || HEXISH.test(seg)) return "[token]";
    return seg;
  });
  return "/" + segments.join("/");
}

/**
 * Scrub free text before it enters the bundle: replace money-shaped runs
 * ("$48.20", "1,234.56") with [amt], collapse long digit runs, drop obvious
 * bearer-ish tokens, and hard-cap the length. Best-effort defence for the one
 * place values can sneak in (a thrown Error's message) — not a substitute for
 * the shape-only rule everywhere else.
 */
export function scrubText(input: string, max = 500): string {
  if (!input) return "";
  let s = String(input);
  s = s.replace(/\$?\d[\d,]*\.\d{2}\b/g, "[amt]");
  s = s.replace(/\b\d{5,}\b/g, "[num]");
  // Long opaque tokens embedded in a message (e.g. a stray JWT/base64url).
  s = s.replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[token]");
  if (s.length > max) s = s.slice(0, max) + "…";
  return s;
}
