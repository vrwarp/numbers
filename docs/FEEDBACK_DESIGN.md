# Feedback & client instrumentation — design contract

Rollout-support system: let a church volunteer report a bug or confusion in a way
that is **identifiable** (which user, deploy, route, and recent requests) and, where
possible, **reproducible** (a redacted breadcrumb trail + the crash), without ever
leaking money, receipt content, signatures, tokens, or other members' data. Built
self-hosted (SQLite + `/data`), matching the app's no-external-services ethos — no
Sentry/PostHog.

This doc is the implementation contract, in the spirit of `ESIGN_DESIGN.md` /
`SEARCH_DESIGN.md` / `NOTIFICATIONS_DESIGN.md`.

## §1 Shape

- **Passive capture** (client): a redacted breadcrumb ring in `sessionStorage`
  (survives a crash-reload), a fetch wrapper that stamps `x-request-id`, and
  `window.onerror`/`unhandledrejection` hooks. `src/lib/feedback/capture.ts`.
- **The report** (user-initiated, high signal): category + optional note + opt-in
  diagnostics. This is the only thing that becomes a `FeedbackReport` row.
- **Storage**: `FeedbackReport` (prisma), one row per submission.
- **Triage**: `/admin` → Feedback tab, admin-gated.

## §2 Two tiers, never a silent stream

User reports are the queue. Passive breadcrumbs/crashes are **never their own rows** —
they only ever ride *inside* a report's `diagnosticsJson`, attached when the user
submits or when the error boundary fires. There is no background telemetry beacon;
in a trust-sensitive church context that would be surprising, and it would be noise.

## §3 Privacy boundary (the crux)

Capture stores **shapes, not values** (`src/lib/feedback/redact.ts`, unit-tested in
`tests/unit/feedback-redact.test.ts`):

- API breadcrumbs: `{method, routeTemplate, status, requestId, ms}`. Ids/query are
  templated out (`/api/reimbursements/[id]/pdf`). **Response bodies are never read**
  (that would also break the app's streaming NDJSON reads), so no error `code` is
  captured client-side.
- Navigation: route templates only.
- Errors: message + stack, run through `scrubText` (money-shaped runs → `[amt]`,
  long digit/token runs redacted, hard length cap).
- Never captured: amounts, descriptions, ministries, notes, signatures, tokens,
  file bytes, other members' identities.

The consent line the user sees is **truthful and plain** (`Feedback.diagnosticsNote`):
version + phone + recent steps, developer-only. Diagnostics are opt-in (default on)
and the whole bundle is dropped if the user unchecks the box. The line deliberately
makes **no "no amounts" promise** — the *breadcrumb bundle* has none, but an opt-in
screenshot (§5) can show anything on screen, so the copy must not over-promise.

## §4 Fire-and-forget (the invariant-11/12 posture)

Capture and reporting **never gate or fail an app mutation**. The fetch wrapper and
breadcrumb writes swallow their own errors; `x-request-id` stamping is best-effort.
The only surface allowed to show an error is the report POST, and even it fails soft
into a `localStorage` **outbox** (`src/lib/feedback/outbox.ts`) that flushes on
reconnect/next load with bounded retries. Server-side the write is rate-capped
(30/user/hour) and size-bounded; a crash loop can't spam or bloat.

## §5 Sensitive-surface policy

`src/lib/feedback/sensitive.ts`: `/approvals`, `/finance`, `/members`, `/vouch`,
`/v/`, `/c/` are sensitive — they show *another* member's data. On them the sheet
discloses it (`Feedback.sensitiveNote`) and **hard-disables the screenshot** (a
locked row, and `submit` drops any stale image). The in-claim e-sign ceremony is a
dialog, not a route, so it can't be route-caught; screenshots being opt-in +
previewed is the backstop. Screenshots are never auto-attached, including on crash
(the crashed screen could be sensitive).

**Screenshots** (`FeedbackRuntime.captureScreenshot` + `ScreenshotAnnotator`,
`src/lib/feedback/storage.ts`): opt-in, off by default. Captured with `html-to-image`
(foreignObject rendering — handles Tailwind v4 `oklch()` and same-origin receipt
`<img>`s; `html2canvas` cannot). **iOS-hardened** — iOS is the primary platform and
WebKit is the flakiest engine here, so capture is **viewport-only** (translate the
clone by scroll, crop to `innerWidth×innerHeight`) to stay under WebKit's ~16M-px
canvas cap, with a **pixel-area budget** dropping `pixelRatio`, and a **warm-up render
on WebKit** (all iOS browsers + desktop Safari) to dodge Safari's blank-first-render
bug. Before sending, the user can **black out** regions (redaction), **draw**, or
**highlight** on a canvas editor, with undo/clear — annotations kept in natural pixels
so the export is full-res. Bytes go to `<DATA_DIR>/feedback/<id>.<ext>` (never a DB
blob), served admin-only, path-traversal-guarded. Best-effort: a capture/store failure
never fails the report.

## §6 Correlation

`handleApi` mints/echoes a short `x-request-id` on every response
(`src/lib/api.ts`). The client records it per API breadcrumb; a report carries the
last ~8 distinct ids. Server-row join (stamping the id onto `ExtractionLog`/
`AuditEvent`) is a **documented future step** — those writes live in ~20 routes and
helpers with no request scope, so today correlation is user + time + route + the
client breadcrumb trail, which is enough to locate the matching server rows.

## §7 Entry points

- **Account menu → "Report a problem"** — the primary, discoverable trigger. No
  floating button: it would collide with the claim's sticky action bar (`bottom-4`).
- **Error boundary** (`src/app/error.tsx`, the app's first) — a calm recovery screen
  with "Report this problem", pre-loaded with the stashed crash after reload.
- Any surface can `openFeedback({category})` (`src/lib/feedback/open.ts`).

## §8 Closed loop

Send lands on an emerald confirmation with a short reference (`shortRef(id)`, e.g.
`#7Q2F`) and a "we read these" status — the acknowledgment that earns the next report.
`GET /api/feedback` returns the caller's own reports for a future Profile list.

## §9 Data model

`FeedbackReport { id, userId(FK Cascade), category, situation, message, route,
buildSha, diagnosticsJson, locale, userAgent, screenshotPath, status(new|triaged|
closed), createdAt }`. Owner-scoped writes; the admin **read** grant over all reports
is a §6.3-style exception (reports carry free-text PII) enforced by `requireAdmin`.
Diagnostics live in the JSON column; the screenshot is a disk path under `DATA_DIR`,
never a DB blob.

## §10 i18n

All strings under `Feedback.*` (+ error codes `Errors.feedback*`), en source of
truth, zh-Hans + zh-Hant authored in parallel — this is a majority-Chinese, mobile,
older audience, so the copy is problem-framed and reassuring, not feature-jargon.

## Deferred (future slices)

- Stamping `x-request-id` onto `ExtractionLog`/`AuditEvent` for exact server-row join.
- Gentle post-error re-prompts (capped).
- Retention/GC sweep (delete stored screenshots + old reports on a schedule; today a
  deleted user cascades the rows but the screenshot files aren't yet swept).
- Optional auto-blur of `data-sensitive` nodes before capture (currently redaction is
  the user's manual black-out in the annotator).
