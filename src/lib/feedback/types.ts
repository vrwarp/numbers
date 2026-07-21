/**
 * Shared feedback types (docs/FEEDBACK_DESIGN.md). Dependency-free so both the
 * client capture layer and the server route import them.
 */

// The severity/situation the user tapped. "crash" is set only by the error
// boundary (error.tsx), never a user chip. Maps to a Feedback.category.* label.
export type FeedbackCategory = "bug" | "confused" | "idea" | "crash";

export const FEEDBACK_CATEGORIES: readonly FeedbackCategory[] = ["bug", "confused", "idea", "crash"];

export const MESSAGE_MAX = 2000;

/**
 * A short, human-quotable reference from a report id (a cuid). Shown in the
 * success sheet ("I filed #7Q2F") and in the admin queue so the two line up —
 * the reporter can name their report and the triager finds it. Not a security
 * token: it's a convenience label over the owner-scoped id.
 */
export function shortRef(id: string): string {
  const tail = id.replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase();
  return tail || "----";
}

export interface Breadcrumb {
  t: number; // ms epoch
  kind: "nav" | "api" | "error";
  // nav: route template · api: "METHOD /template" · error: scrubbed message.
  label: string;
  status?: number; // api HTTP status (0 = network failure)
  rid?: string; // api correlation id (x-request-id)
  ms?: number; // api duration
}

export interface DiagnosticsEnv {
  ua: string;
  lang: string;
  platform: string;
  viewport: string; // "390x844"
  dpr: number;
}

export interface CrashInfo {
  message: string;
  stack: string;
}

export interface Diagnostics {
  route: string; // templated current route
  sensitive: boolean;
  env: DiagnosticsEnv;
  breadcrumbs: Breadcrumb[];
  requestIds: string[]; // recent distinct correlation ids
  crash: CrashInfo | null;
  capturedAt: number;
}

// The wire payload POSTed to /api/feedback.
export interface FeedbackPayload {
  category: FeedbackCategory;
  situation?: string;
  message: string;
  route: string;
  buildSha: string;
  locale: string;
  // Redacted bundle, or null when the user turned diagnostics off.
  diagnostics: Diagnostics | null;
}
