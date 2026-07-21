import { shortRef } from "./types";

/**
 * Render one feedback report as well-formatted markdown for the admin "Copy"
 * button (paste into an issue tracker / chat). Pure and dependency-free so it's
 * unit-tested; the caller supplies already-localized display strings (category,
 * status, timestamp) so this module stays free of i18n. Tolerant of partial or
 * absent diagnostics — a report with `null` diagnostics still copies cleanly.
 */

export interface FeedbackReportLike {
  id: string;
  category: string;
  situation: string;
  message: string;
  route: string;
  buildSha: string;
  locale: string;
  userAgent: string;
  status: string;
  createdAt: string;
  reporter: string;
  diagnostics: unknown;
  hasScreenshot?: boolean;
}

export interface MarkdownLabels {
  /** Localized category label (e.g. "This is broken"). */
  category: string;
  /** Localized status label (e.g. "New"). */
  status: string;
  /** Formatted timestamp (e.g. "Jul 20, 2026, 9:58 PM"). */
  when: string;
}

interface Diag {
  route?: string;
  sensitive?: boolean;
  env?: { ua?: string; lang?: string; platform?: string; viewport?: string; dpr?: number };
  breadcrumbs?: Array<{ t?: number; kind?: string; label?: string; status?: number; rid?: string; ms?: number }>;
  requestIds?: string[];
  crash?: { message?: string; stack?: string } | null;
}

// Epoch ms → "HH:MM:SS" (UTC, stable — the value is for ordering, not wall clock).
function hhmmss(t: unknown): string {
  if (typeof t !== "number" || !Number.isFinite(t)) return "";
  return new Date(t).toISOString().slice(11, 19);
}

// Escape a value so it can't break out of a markdown table cell.
function cell(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function reportToMarkdown(r: FeedbackReportLike, labels: MarkdownLabels): string {
  const out: string[] = [];
  out.push(`# Feedback #${shortRef(r.id)} — ${labels.category}`);
  out.push("");
  out.push(`- **Status:** ${labels.status}`);
  out.push(`- **Reported by:** ${r.reporter}`);
  out.push(`- **When:** ${labels.when}`);
  if (r.route) out.push(`- **Route:** \`${r.route}\``);
  if (r.situation) out.push(`- **Situation:** ${r.situation}`);
  if (r.buildSha) out.push(`- **Build:** \`${r.buildSha}\``);
  out.push(`- **Locale:** ${r.locale}`);
  if (r.userAgent) out.push(`- **Device:** ${r.userAgent}`);
  if (r.hasScreenshot) out.push(`- **Screenshot:** attached (view in admin)`);
  out.push(`- **Report id:** \`${r.id}\``);

  out.push("");
  out.push("## Message");
  out.push("");
  out.push(r.message ? r.message : "_(no message)_");

  const d = r.diagnostics && typeof r.diagnostics === "object" ? (r.diagnostics as Diag) : null;
  const env = d?.env;
  const crumbs = d?.breadcrumbs;
  const crash = d?.crash;
  const hasDiag =
    d &&
    ((env && Object.keys(env).length > 0) ||
      (d.requestIds && d.requestIds.length > 0) ||
      (crumbs && crumbs.length > 0) ||
      (crash && (crash.message || crash.stack)) ||
      typeof d.sensitive === "boolean");

  if (hasDiag) {
    out.push("");
    out.push("## Diagnostics");

    if (env && Object.keys(env).length > 0) {
      out.push("");
      out.push("**Environment**");
      out.push("");
      if (env.viewport) out.push(`- Viewport: ${env.viewport}${env.dpr ? ` @${env.dpr}x` : ""}`);
      if (env.platform) out.push(`- Platform: ${env.platform}`);
      if (env.lang) out.push(`- Language: ${env.lang}`);
      if (env.ua) out.push(`- User agent: ${env.ua}`);
    }

    if (d?.requestIds && d.requestIds.length > 0) {
      out.push("");
      out.push(`**Recent request ids:** ${d.requestIds.map((x) => `\`${x}\``).join(", ")}`);
    }

    if (crumbs && crumbs.length > 0) {
      out.push("");
      out.push("**Recent activity**");
      out.push("");
      out.push("| time | kind | detail | status | ms | rid |");
      out.push("| --- | --- | --- | --- | --- | --- |");
      for (const c of crumbs) {
        out.push(
          `| ${hhmmss(c.t)} | ${cell(c.kind)} | ${cell(c.label)} | ${cell(c.status)} | ${cell(c.ms)} | ${cell(c.rid)} |`
        );
      }
    }

    if (crash && (crash.message || crash.stack)) {
      out.push("");
      out.push("**Crash**");
      out.push("");
      out.push("```");
      if (crash.message) out.push(crash.message);
      if (crash.stack) out.push(crash.stack);
      out.push("```");
    }

    if (typeof d?.sensitive === "boolean") {
      out.push("");
      out.push(`_Captured on a ${d.sensitive ? "sensitive" : "normal"} surface._`);
    }
  }

  out.push("");
  return out.join("\n");
}
