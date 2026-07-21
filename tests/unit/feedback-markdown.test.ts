import { describe, expect, it } from "vitest";
import { reportToMarkdown, type FeedbackReportLike } from "@/lib/feedback/report-markdown";

const base: FeedbackReportLike = {
  id: "cmru6942b00027dwddtzgejkh",
  category: "bug",
  situation: "",
  message: "The PDF button stayed greyed out after I verified every row.",
  route: "/claims/[id]",
  buildSha: "abc1234",
  locale: "en",
  userAgent: "Mozilla/5.0 iPhone",
  status: "new",
  createdAt: "2026-07-20T21:58:00.000Z",
  reporter: "Grace Chan",
  diagnostics: null,
};

const labels = { category: "This is broken", status: "New", when: "Jul 20, 2026, 9:58 PM" };

describe("reportToMarkdown", () => {
  it("renders a header, meta list, and message for a diagnostics-less report", () => {
    const md = reportToMarkdown(base, labels);
    expect(md).toContain("# Feedback #EJKH — This is broken");
    expect(md).toContain("- **Status:** New");
    expect(md).toContain("- **Reported by:** Grace Chan");
    expect(md).toContain("- **Route:** `/claims/[id]`");
    expect(md).toContain("- **Build:** `abc1234`");
    expect(md).toContain("## Message");
    expect(md).toContain("The PDF button stayed greyed out after I verified every row.");
    // No diagnostics section when there are none.
    expect(md).not.toContain("## Diagnostics");
  });

  it("shows a placeholder for an empty message", () => {
    const md = reportToMarkdown({ ...base, message: "" }, labels);
    expect(md).toContain("_(no message)_");
  });

  it("renders env, request ids, a breadcrumb table, and a crash block", () => {
    const md = reportToMarkdown(
      {
        ...base,
        category: "crash",
        diagnostics: {
          route: "/claims/[id]",
          sensitive: false,
          env: { ua: "iPhone Safari", lang: "en", platform: "iPhone", viewport: "390x844", dpr: 3 },
          requestIds: ["abc123", "def456"],
          breadcrumbs: [
            { t: 1_700_000_000_000, kind: "api", label: "POST /api/reimbursements/[id]/pdf", status: 400, rid: "abc123", ms: 42 },
          ],
          crash: { message: "TypeError: x is undefined", stack: "at foo\nat bar" },
        },
      },
      { ...labels, category: "The app crashed" }
    );
    expect(md).toContain("## Diagnostics");
    expect(md).toContain("**Environment**");
    expect(md).toContain("- Viewport: 390x844 @3x");
    expect(md).toContain("**Recent request ids:** `abc123`, `def456`");
    expect(md).toContain("| time | kind | detail | status | ms | rid |");
    expect(md).toContain("POST /api/reimbursements/[id]/pdf");
    expect(md).toContain("**Crash**");
    expect(md).toContain("TypeError: x is undefined");
  });

  it("escapes pipes so a label can't break the table", () => {
    const md = reportToMarkdown(
      {
        ...base,
        diagnostics: { breadcrumbs: [{ t: 1_700_000_000_000, kind: "nav", label: "GET /a|b" }] },
      },
      labels
    );
    expect(md).toContain("GET /a\\|b");
  });
});
