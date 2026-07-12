# Localization plan: English + 简体中文 + 繁體中文

*Status: IMPLEMENTED (P0–P5, commits `d414359`…on this branch). Kept as the design rationale
record; file:line references below describe the codebase as of `1d8383b` (pre-implementation).
Current conventions live in `docs/agent/CONVENTIONS.md` "Localization"; the workflow in
`messages/GLOSSARY.md` + `scripts/translate-messages.ts`. Still open (P6 / review): native
review of the machine-drafted zh catalogs, ministry display labels, AI output-language
steering, and open questions 1–6 below.*

## Goal

Ship the UI in three languages — **English** (default), **Simplified Chinese** (`zh-Hans`,
audience: people from China) and **Traditional Chinese** (`zh-Hant`, audience: people from
Taiwan/Hong Kong) — such that:

- every string has **one source of truth** (the English catalog), and drift between languages
  is caught by `npm run build` / `npm test`, not by users;
- the existing hard invariants survive untouched: integer-cents money, the AcroForm field
  contract, testid-driven e2e, 404-on-cross-tenant, the human verification gate;
- adding language #4 later is adding one JSON file, not another engineering project.

Not all text in this app is the same kind of text. The audit (below) shows four classes that
need four different treatments — conflating them is how i18n projects rot:

| Class | Examples | Treatment |
| :-- | :-- | :-- |
| **1. UI chrome** | buttons, headings, empty states, `confirm()` prompts, aria-labels | Translate via message catalogs (the bulk of this plan) |
| **2. Server-produced messages** | the ~55 `ApiError` strings, NDJSON progress lines | Machine-readable `code` + params; **client** renders the translation |
| **3. Domain data** | ministry list, status enums, user-typed descriptions/notes | Canonical values stay as-is; optional *display* labels; never translate user data |
| **4. Generated artifacts** | the CFCC PDF, AI-written summaries | Form stays English; **content** must survive in Chinese (font work); AI output language becomes a deliberate choice |

## What the audit found

### Inventory (distinct user-visible strings)

| Surface | Count | Notes |
| :-- | :-- | :-- |
| `src/components/*` (11 files, all `"use client"`) | ~259 | ReviewClaim ~90, Shoebox ~42 — half the total, and nearly all the hard cases |
| `src/app/*` pages + layout (all server components) | ~16 | plus `metadata` in `layout.tsx:6-15`, `<html lang="en">` at `layout.tsx:28` |
| API error strings (`ApiError` literals) | ~55 | single shape `{error: string}`, no code field (`src/lib/api.ts:18-29`) |
| Streamed progress text | 1 | quota-wait line built in `src/lib/ai/extract.ts:102` |
| PDF literals (drawn/baked) | ~8 | `"Receipt N of M"`, `"(continued)"`, `"Page x of y"`, QR note box |
| Ministry labels (`src/lib/ministries.ts:10-82`) | ~60 | **data, not chrome** — stored value, PDF value, and AI-validation key |
| **Total to translate (classes 1–2)** | **~330** | |

### Facts that shape the design

- **No i18n machinery exists.** No library, no locale files, no `Intl.*` call anywhere, no
  locale cookie, `Accept-Language` never read. Greenfield.
- **Everything user-facing is client-rendered.** All 11 components are client components; the
  7 pages are thin server shells. Whatever we pick must work in both, but the client side
  dominates.
- **API errors surface raw in the UI, pervasively.** The idiom
  `setError((await res.json()).error ?? "…")` / rendering `e.message` appears in every
  data-touching component (e.g. `ProfileForm.tsx:41`, `Shoebox.tsx:351`,
  `ReviewClaim.tsx:1513`). Translating components alone leaves English error prose in a
  Chinese UI.
- **zod messages never reach users** — every route does `safeParse` → fixed
  `ApiError(400, "…")` literal and never reads `parsed.error`. Only the hand-written literals
  need treatment.
- **English grammar is baked into code**: ad-hoc plurals
  (`` `receipt${n > 1 ? "s" : ""}` `` — `AddReceiptsDialog.tsx:138,258`, `Shoebox.tsx:341,450`,
  `claims/page.tsx:45`), sentences assembled from JSX fragments with links/`<strong>`
  mid-sentence (`page.tsx:22-25`, `ReviewClaim.tsx:880-906`), 3-way ternaries producing whole
  sentences (`ReviewClaim.tsx:1446-1451`), pronoun agreement (`PdfReceiptPreview.tsx:89-93`).
- **Status enums are mapped to English inline in four scattered places**
  (`ReviewClaim.tsx:517`, `claims/page.tsx:55`, `ReceiptGrid.tsx:188`, `Shoebox.tsx:536`).
- **Dates**: bare `toLocaleDateString()` (ambient runtime locale — the *server's* locale on
  `claims/page.tsx:42`, the *browser's* on `ReceiptGrid.tsx:175,188`) plus hand-built
  `MM/DD/YYYY` in `ReviewClaim.tsx:81-85` and on the PDF (`pdf/route.ts:64`). Inconsistent
  even before i18n.
- **The UI font stack has no explicit CJK coverage** (`globals.css:4`) — CJK falls through to
  whatever `system-ui` resolves; zh-Hans vs zh-Hant glyph forms are left to chance.
- **Tests lean on English text**: ~94 visible-text selectors across the e2e suites
  (`journey.spec.ts` alone has 43: `getByText("Subtotal: $102.10")`,
  `getByLabel("Ministry", { exact: true })`, `toHaveText("Draft")`…), plus Vitest assertions
  on exact strings (`money.test.ts:42`, `pdf.test.ts:124-126`).

### The already-live bug: Chinese content is destroyed on the PDF

This is the finding that upgrades part of this plan from "feature" to "bug fix". The form fill
uses Standard-14 Helvetica (WinAnsi-only, `generate.ts:148,176`; fontkit is not registered
anywhere), so `toEncodableText` (`generate.ts:127-141`) deliberately strips every
non-encodable run to `"…"` before `field.setText`. The unit tests pin this behavior
(`pdf.test.ts:294-318`):

```
toEncodableText("大華超市 99 Ranch Market 06/28 — 燒臘, rice")
  → "… 99 Ranch Market 06/28 — …, rice"
toEncodableText("中文事工 Chinese Ministry")  → "… Chinese Ministry"
```

Meanwhile the extraction prompt tells the model to transcribe `merchant` "as printed" and to
keep the receipt's abbreviations (`prompt.ts:11,15`) — so a receipt from a Chinese grocery
store **already** produces a Chinese description that renders fine on the review screen and
then silently degrades to ellipses on the official form. The congregation is demonstrably
bilingual (the chart of accounts includes `"355 Library - Mandarin"`,
`"410 Choir/Worship Team - Mandarin"`, `"450 Joshua Fellowship - Mandarin"`). Phase 0 fixes
this independently of everything else.

---

## Design

### 1. Locale model: `en`, `zh-Hans`, `zh-Hant`

Use **script subtags**, not region codes. The Traditional audience spans Taiwan *and* Hong
Kong; `zh-Hant` names the script without picking a region, and both `zh-TW` and `zh-HK`
browsers negotiate onto it. `Intl` accepts script subtags directly
(`new Intl.DateTimeFormat("zh-Hant")` works).

Two catalogs, **not** an auto-converted one. Hans→Hant is not a character-set transform:
vocabulary diverges (sign in = 登录 vs **登入**, save = 保存 vs **儲存**, generate = 生成 vs
**產生**). OpenCC-style conversion may be used to *draft* the Hant catalog, never to generate
it at build time.

Resolution order (first hit wins):

1. `numbers_locale` cookie (1-year, `SameSite=Lax`) — the runtime source of truth;
2. `Accept-Language` negotiation: `zh-TW | zh-HK | zh-MO | zh-Hant*` → `zh-Hant`;
   `zh | zh-CN | zh-SG | zh-Hans*` → `zh-Hans`; else `en`;
3. `en`.

Persistence: new column `User.locale String @default("en")` (the `role` column shows the
free-string pattern; one migration). `PATCH /api/profile` accepts
`locale: z.enum(["en","zh-Hans","zh-Hant"])` and the profile page gets a language field. On
sign-in, `POST /api/auth/session` — which already sets the session cookie — also sets
`numbers_locale` from `User.locale`, so the preference follows the user to a new device.

Switching: a small language menu in `NavBar` **and** on the sign-in page (pre-auth users need
it too). It writes the cookie client-side (`document.cookie`) and calls `router.refresh()` —
no new API route, so no new exception to the `requireUserId` invariant. When signed in it also
fires the profile PATCH. `GET /c/[token]` serves a PDF, not HTML — nothing to localize there.

`<html lang>` becomes the resolved locale (a11y, and it drives the CJK font selection below).

### 2. Library: `next-intl`, without locale routing

Recommendation: **next-intl**. It is the de-facto App Router library: first-class server
components (`getTranslations`) and client components (`useTranslations`), ICU MessageFormat
(plurals, select, rich text), `useFormatter` wrappers over `Intl`, and — decisive for this
repo — **TypeScript augmentation that type-checks every key against `messages/en.json`**, so
a typo'd or deleted key fails `npm run build`, the validation gate this repo already runs.

Explicitly **without** URL locale routing (`/zh-Hans/...`): the app is auth-gated with no SEO
surface, URL-prefix routing would require middleware (this repo deliberately has none —
`CONVENTIONS.md` "There is NO middleware"), and cookie-based resolution keeps every existing
URL, bookmark, and QR link stable. next-intl supports this mode via `getRequestConfig` reading
`cookies()`/`headers()`.

Alternatives considered:

| Option | Why not |
| :-- | :-- |
| `react-i18next` / `i18next` | Mature, but server-component support is bolted on (per-request instances); `next-i18next` targets the Pages Router. More runtime, less type safety. |
| Lingui | Nice macro DX, but the SWC macro plugin is version-locked to Next's SWC — a recurring breakage on Next upgrades. Wrong trade for a sporadically-maintained app. |
| Paraglide (inlang) | Compile-time and tiny, but young ecosystem, non-ICU message format, App Router integration still churning. |
| Hand-rolled `getDictionary()` | Zero deps but re-implements plurals, rich text, key type-safety, and formatting badly. ~330 strings with ICU needs is past the DIY threshold. |

Cost: one runtime dependency; the active locale's messages ride to the client through the
provider (~330 messages ≈ 25–35 KB of JSON, only the selected locale — acceptable).

Wiring sketch (no code changes yet; shapes what P1 builds):

```ts
// src/i18n/request.ts
export default getRequestConfig(async () => {
  const locale = await resolveLocale();               // cookie → Accept-Language → "en"
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});

// src/app/layout.tsx
const locale = await getLocale();
<html lang={locale}> …
  <NextIntlClientProvider messages={await getMessages()}>{children}</NextIntlClientProvider>

// global.d.ts — every t("…") key checked against the English catalog at build time
declare module "next-intl" {
  interface AppConfig { Messages: typeof import("./messages/en.json") }
}
```

### 3. Message catalogs and authoring rules

```
messages/
  en.json        ← source of truth; keys mirror component names
  zh-Hans.json
  zh-Hant.json
```

Namespaces follow the file map (`NavBar`, `Shoebox`, `ReviewClaim`, `SignInCard`, …) plus
`Common` (shared buttons/status labels), `Errors` (API error codes, §4), and `Meta`
(titles/descriptions). ICU everywhere:

```jsonc
// en.json                                     // zh-Hant.json
"AddReceipts": {                               "AddReceipts": {
  "reading": "Reading {count, plural,            "reading": "正在用 AI 讀取
      one {# receipt} other {# receipts}}            {count} 張收據…",
      with AI…",
  "addSelected": "✨ Add {count, plural,          "addSelected": "✨ 加入 {count} 張收據"
      one {# receipt} other {# receipts}}"     }
}
```

Chinese needs no plural branches (measure word 張 does the work) — ICU lets each language use
its own grammar, which is exactly what `` `receipt${n > 1 ? "s" : ""}` `` can't do.

Authoring rules (these become a CONVENTIONS.md section; they are what keeps this maintainable):

1. **Whole sentences, single keys.** Never assemble a sentence from JSX fragments or string
   concatenation. Inline links/bold use `t.rich`:
   `"nudge": "Your <link>profile</link> is missing a name or mailing address — both get printed on the reimbursement form."`
   with `{ link: (chunks) => <Link href="/profile">{chunks}</Link> }`. (Fixes `page.tsx:22-25`,
   `claims/page.tsx:30-33`, `SignInCard.tsx:195-198`, the ReviewClaim dialogs.)
2. **Named arguments**, never positional: `{merchant}`, `{count}`, `{seconds}`.
3. **Every branch is its own key** — a 3-way ternary selects between three keys, it doesn't
   splice clauses (`ReviewClaim.tsx:880-906` mode-switch paragraph becomes 2–3 keys with a
   `{distinct, plural, …}` argument).
4. **`confirm()`/`alert()` prompts, placeholders, `title`/`aria-label`s are strings too** —
   all through `t()`.
5. **Enum → label via catalog**: one `Common.status.{draft|generated|unassigned|processed}`
   map replaces the four inline mappings. Raw DB values never render.
6. **Don't translate data**: user descriptions/notes/events, merchant names, uploaded
   filenames, the AI `rationale` (§7), ministry canonical values (§6) render as-is.
7. **Keys are stable IDs**; renaming a key is a deliberate three-file change. The parity test
   (§10) fails on any key-set or ICU-argument mismatch between locales.

### 4. Server-produced messages: error codes, translated client-side

The server stays locale-free. API responses gain a stable machine-readable code alongside the
existing English text:

```ts
class ApiError extends Error {
  constructor(status: number, message: string, code?: string, params?: Record<string, string | number>)
}
// handleApi → { error: "Claim already generated; line items are frozen",
//               code: "claimFrozen" }            ← params included when present
```

Client-side, one helper replaces the `?? "fallback"` idiom everywhere:

```ts
function apiErrorMessage(body: unknown, t: Translator): string {
  // known code → t(`Errors.${code}`, params); unknown/absent → body.error → t("Errors.generic")
}
```

Why client-side translation instead of `Accept-Language` on the server: the server needs no
locale plumbing at all, logs and `curl` output stay greppable English, the ~94 e2e text
assertions and `security.spec.ts` keep passing unchanged, and the English `error` field
remains a built-in fallback for codes a stale client doesn't know. The ~55 literals collapse
to ~45 codes (dedup: `"Claim not found"` is thrown from 10 sites, `"Receipt not found"` from
6 — one code each).

The NDJSON stream (`src/lib/claim-stream.ts`) is already structured; only two lines carry
prose. `quota-wait` already ships `attempt`/`maxRetries`/`cooldownMs`, so the client composes
the localized sentence itself and the server's `message` (built at `extract.ts:102`) becomes a
log-only fallback. The `error` line gains the same optional `code` field. Interpolated errors
keep their params (`{ code: "rowsUnverified", params: { count: 3 } }` →
`"{count, plural, …} still need verification…"`).

Not worth translating (leave English): the internal/config-error leak surface
(`"CFCC form template PDF is missing"`, `"AUTH_SECRET must be set…"`), `fbauth` proxy plain
text, and Firebase SDK messages (`SignInCard.tsx:89` already branches on error *codes* for its
own copy — extend that pattern, show `t("SignIn.failed")` for the rest).

### 5. PDF: the form stays English; the *content* must survive CJK (Phase 0, a bug fix)

Two distinct things live on the PDF:

- **The form** — labels baked into `assets/cfcc-form-template.pdf`, plus our English literals
  (`"(continued)"`, `"Page x of y"`, the QR note box in `qr.ts:36-42`, `"Receipt N of M"`
  labels). Audience: the treasurer processing the paper. **Stays English. Non-goal.**
- **The filled values** — descriptions, ministry/event, requester name/address, receipt
  notes. This is user data and is being destroyed today (§audit). Fix:

1. Add `@pdf-lib/fontkit` + one CJK font under `assets/fonts/` (recommend **Noto Sans CJK
   TC or SC**, OFL-licensed; one face covers the full unified-Han repertoire plus Latin;
   ~16 MB in repo/image — acceptable for a single-container app; glyph-form preference
   TC-vs-SC is an open question below).
2. `doc.registerFontkit(fontkit)`; `embedFont(bytes, { subset: true })` — output PDFs grow by
   the used glyphs only (tens of KB), not 16 MB.
3. Per-field font choice in `setText` (`generate.ts:181-204`): value fully
   WinAnsi-encodable → keep Helvetica (form's native look); otherwise use the CJK font for
   `field.setText` + `field.updateAppearances(cjk)` + the `fittingFontSize` measurement
   (it already takes the font as a parameter). Same treatment for the drawn receipt label
   (`generate.ts:305`, notes can be Chinese).
4. `toEncodableText` survives, parameterized by the *chosen* font — it becomes a safety net
   for glyphs even Noto lacks, instead of a CJK shredder.

**Spike first**: pdf-lib's `subset: true` together with AcroForm appearance streams + flatten
has known rough edges. Day one of P0 is a throwaway script proving
Chinese-description → `generateClaimPdf` → correct rasterized output via the existing
`scripts/render-pdf.mjs`. If subsetting misbehaves with form fields, the documented fallbacks
are (a) generate appearances, flatten, then save, or (b) draw values as page text over the
flattened form. Test note: `pdfVisibleText` (`tests/unit/pdf.test.ts`) decodes WinAnsi hex —
subset CID fonts encode *glyph IDs*, so CJK assertions must go through rasterization (or the
ToUnicode CMap) instead; the three tests pinning today's ellipsis behavior
(`pdf.test.ts:294-318`) are replaced by "CJK round-trips" tests.

The PDF's `Request Date` stays `MM/DD/YYYY` (`pdf/route.ts:64`) and amounts stay
`centsToDollarString` — treasurer-facing conventions.

### 6. Domain data: ministries and status values

**Ministry canonical values do not change.** `"237 Office Supplies"` is simultaneously the
stored `LineItem.ministry`, the string printed on the form, the `isKnownMinistry` membership
key (`ministries.ts:88`), and the AI suggestion validation target (`suggest.ts:79-93`).
Translating the value would desync all four.

What CAN change is the *display*: `MINISTRY_GROUPS` entries gain optional per-script labels,

```ts
{ value: "237 Office Supplies", zhHans: "办公用品", zhHant: "辦公用品" }
```

and the dropdowns render `237 Office Supplies · 辦公用品` (account number + English always
visible, since that's what lands on the form the user signs). Stored value, PDF, and AI
validation are untouched. This is ~54 church-specific translations that should come from the
church itself (bulletins/announcements likely already name these ministries in Chinese) — its
own phase, deliverable as data.

**Status labels** move to `Common.status.*` in the catalog (rule 5 above). The literal
`"Other…"` / `"— pick ministry —"` options are chrome and translate normally; the
`OTHER_MINISTRY = "__other__"` sentinel is invisible and stays.

### 7. AI-generated content language

Today the model transcribes and summarizes with no language instruction — Chinese receipts
yield Chinese summaries, English receipts English ones. That's a defensible default
(*transcription* fidelity), so this plan changes nothing by default, but adds one deliberate
option in a later phase: pass the user's locale into `buildExtractionPrompt` /
`buildSuggestionPrompt` as *"write `summary` (and `rationale`) in {language}; transcribe
`merchant` exactly as printed"*.

Flagged as an **open policy question** rather than a default because the summary becomes the
line-item description **printed on the form the treasurer reads** — whether the church wants
Chinese descriptions on filed paperwork is the church's call, not the code's. (After P0 the
PDF can at least render them faithfully either way.) Mock fixtures (`ai/mock.ts`) ignore
prompts, so e2e is unaffected whichever way this lands.

### 8. Formatting: dates, numbers, money

- **Dates**: all UI dates go through next-intl's `useFormatter().dateTime()` bound to the
  app locale — replacing ambient `toLocaleDateString()` (`ReceiptGrid.tsx:175,188`,
  `claims/page.tsx:42`) and the hand-rolled `MM/DD/YYYY` in `receiptLabel()`
  (`ReviewClaim.tsx:81-85`). zh locales get `2026年6月21日` for free. The `MM/DD` inside
  *stored* descriptions (`compose.ts:19-24`) is data, frozen at extraction — unchanged.
- **Money**: **`formatCents` stays exactly as it is** (`$12.34`). Amounts are USD on a US
  form; `$`-prefix notation is standard in zh contexts for USD; changing it would ripple
  through e2e money assertions and PDF parity for zero user benefit. Revisit only if users ask.
- One cheap hardening for Chinese IME users: `parseDollarsToCents` normalizes full-width
  digits/punctuation (`１２.３４` → `12.34`) before validating — one line in the only money
  parser (`money.ts`).
- **Collation**: nothing user-visible sorts by string today (only numeric `sortOrder`); if
  translated ministry labels ever get sorted, use `Intl.Collator(locale)` — noted for
  CONVENTIONS.md.
- Unit suffixes (`KB`, `%`, `{n} left`) become catalog strings with number arguments.

### 9. UI fonts for CJK

No webfonts — CJK font files are megabytes and every target OS ships good ones. Extend the
stack in `globals.css` per script via `html[lang]`:

```css
html[lang="zh-Hans"] body { font-family: var(--font-sans-latin), "PingFang SC",
  "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
html[lang="zh-Hant"] body { font-family: var(--font-sans-latin), "PingFang TC",
  "Microsoft JhengHei", "Noto Sans CJK TC", sans-serif; }
```

This keeps Latin text in the current stack and — the part `system-ui` alone doesn't
guarantee — renders unified-Han codepoints with the *correct regional glyph forms* for each
audience (骨/说/門 differ between SC and TC faces).

### 10. Tests and enforcement

- **e2e stays green in English.** Pin `locale: "en-US"` in every Playwright project (belt) —
  with no cookie set, resolution already lands on `en` (braces). The ~94 text selectors keep
  working untouched. New tests keep preferring `data-testid` (already house style).
- **New `i18n.spec.ts` smoke**: switch language via the NavBar menu → assert `<html lang>`,
  one translated heading (`收據盒` etc.), persistence across reload, and that the profile
  PATCH round-trips `locale`.
- **Catalog parity + staleness unit test** (Vitest, runs in `npm test`): the three JSON files
  have identical key sets; every message's ICU argument names match the English source; and
  every key's `sourceHash` in `messages/translation-state.json` matches the current English
  value. Together these make both failure modes a red build instead of a silent leak: "added a
  string, forgot the translation" *and* "reworded the English, the Chinese is now stale"
  (workflow mechanics in §11).
- **Type-checked keys**: `t("Shoebox.emptyTitl")` fails `npm run build` (§2 augmentation).
- **PDF tests**: replace the ellipsis-contract tests with CJK round-trip tests (§5).
- Hardcoded-string *lint* (e.g. `eslint-plugin-i18next/no-literal-string`) is **not** proposed
  now — the repo has no ESLint at all, and adopting a lint stack is a bigger decision than
  i18n needs. The typed keys + parity test + review discipline carry it; revisit if English
  literals keep sneaking in.

### 11. Translation workflow: adding, re-running, and feeding context

`messages/en.json` changes in the same PR as the code. Chinese catalogs are drafted by machine
and **reviewed by a bilingual member of the congregation** — the church has Mandarin-named
ministries, so reviewers exist. Everything lives in git; no external translation platform (a
TMS is overkill for three locales and one reviewer per script — revisit only if that grows).

Three files carry the pipeline:

- `scripts/translate-messages.mjs` (npm alias `npm run translate`) — reuses the existing AI
  provider plumbing (`src/lib/ai/providers.ts`), so the deployment's OpenRouter/Gemini key is
  the translation key too.
- `messages/GLOSSARY.md` — the glossary table below, moved into the repo. Pinned into every
  translation prompt; the authority reviewers enforce.
- `messages/translation-state.json` (committed) — per-key bookkeeping that makes re-runs safe:

```jsonc
"ReviewClaim.splitButton": {
  "sourceHash": "9f2c1a",                            // hash of the en value translated from
  "zh-Hans": "reviewed", "zh-Hant": "machine",       // todo | machine | reviewed
  "context": "Button on a line-item row; splits it in two. Keep short."  // optional
}
```

The parity test (§10) checks `sourceHash` against the current English value, which turns
"someone reworded the English and the Chinese is now stale" from a silent lie into a red
build. The day-to-day loops:

- **New string**: add `t("Ns.key")` + the `en.json` entry → `npm test` goes red (key missing
  in zh catalogs) → `npm run translate` drafts both Chinese entries (status `machine`) and
  writes the state row → commit all four files in the PR. No AI key on hand?
  `npm run translate -- --todo` copies the English value as a placeholder (status `todo`,
  renders English, grep-able) so the build stays green and the draft happens later.
- **Reworded English string**: `npm test` goes red on the hash mismatch →
  `npm run translate` re-drafts exactly the stale keys. The prompt includes the *previous*
  translation as reference ("preserve its terminology where still accurate"), so a reviewed
  phrasing isn't thrown away — but the status drops back to `machine`, because the old human
  approval no longer covers the new meaning.
- **Glossary or context changed**: `npm run translate -- --all` re-drafts every
  `machine`-status key with the updated context. `reviewed` keys are never overwritten by any
  mode without `--force` — human work is protected by default; the run report lists reviewed
  keys so the reviewer can spot-check whether the change affects them.
- **Review**: the reviewer edits the zh value if needed and flips the status to `reviewed` in
  `translation-state.json` — an ordinary git-audited PR, no tooling to learn.
- Keys deleted from `en.json` are pruned from the catalogs and state by the script; the parity
  test catches orphans regardless.

Context flows into the prompt from three layers: the glossary (global), the per-key `context`
field (worth writing for ambiguous short strings — "Draft", "Split", "Claims"), and the key's
namespace plus sibling messages (automatic, tells the model what screen it is on). If the
operator's `church-context.md` vocabulary doc (§`src/lib/church-context.ts`) exists, the
script can ingest it too — the same church terminology that guides ministry suggestions
guides translation.

Starter glossary — the ~15 load-bearing terms, chosen once, used everywhere. Note the
Hans/Hant pairs that differ by *vocabulary*, not just script (why two catalogs, §1):

| en | zh-Hans | zh-Hant | note |
| :-- | :-- | :-- | :-- |
| receipt | 收据 | 收據 | |
| claim / reimbursement | 报销单 / 报销 | 報銷單 / 報銷 | TW alt 請款單 — reviewer's call |
| Shoebox (the feature) | 收据盒 | 收據盒 | keep the metaphor, not literal 鞋盒 |
| ministry | 事工 | 事工 | standard church usage |
| event | 活动 | 活動 | |
| verify / verified | 核对 / 已核对 | 核對 / 已核對 | alt 确认/確認 |
| draft | 草稿 | 草稿 | |
| generated | 已生成 | 已產生 | vocabulary divergence |
| split / merge | 拆分 / 合并 | 拆分 / 合併 | |
| exclude | 排除 | 排除 | "personal / not reimbursable" needs care |
| upload | 上传 | 上傳 | |
| sign in / out | 登录 / 退出登录 | 登入 / 登出 | classic divergence |
| save | 保存 | 儲存 | classic divergence |
| suggest (AI) | 建议 | 建議 | |
| total | 总额 | 總額 | |

Never translated: **Numbers** (app name), **CFCC**, account numbers, merchant names, anything
the user typed.

---

## Phases

Each phase is independently shippable and leaves `main` releasable. Through P2 the English
strings must stay *byte-identical* to today's — that way the existing e2e suite doubles as the
refactor harness for every extraction PR, and nothing user-visible changes until the switcher
(P3) and the catalogs (P4) land.

| Phase | Contents | Size |
| :-- | :-- | :-- |
| **P0 — CJK survives the PDF** *(bug fix, independent)* | fontkit spike → `assets/fonts/` + per-field font choice + `toEncodableText` parameterized + receipt-label path + replace ellipsis tests with round-trip tests + visual check via `render-pdf.mjs` | S–M; do first |
| **P1 — plumbing, en only** | `next-intl` dep, `messages/en.json` skeleton, `src/i18n/request.ts` (cookie → Accept-Language → en), provider in layout, `<html lang>`, typed keys, parity test. Zero visible change | S |
| **P2 — string extraction** | Component-by-component PRs (suggested order: NavBar+pages → Shoebox → ReviewClaim → the rest), applying authoring rules 1–7: ICU plurals, `t.rich` sentences, `confirm()` prompts, status-label centralization, date formatting via `useFormatter`, full-width digit parse | M–L (~330 strings; ReviewClaim+Shoebox ≈ half) |
| **P3 — locale switching** | `User.locale` migration, profile field + zod enum, NavBar & sign-in switchers, session-sets-cookie, `generateMetadata`, CJK font stacks, `i18n.spec.ts` | S–M |
| **P4 — Chinese catalogs** | `messages/GLOSSARY.md` sign-off, `scripts/translate-messages.mjs` + `translation-state.json` (the §11 pipeline), machine-draft `zh-Hans`/`zh-Hant`, native review, staleness check joins the parity test | M (review-bound) |
| **P5 — error codes** | `ApiError` code+params, `apiErrorMessage` helper replacing the `?? "fallback"` idiom, NDJSON `code`, `Errors.*` catalog | M (~45 codes, many call sites) |
| **P6 — optional follow-ups** | Ministry display labels (church-supplied), AI output-language steering (policy decision), localized PDF filename stem, ESLint literal-string guard | as demanded |

P0 and P1 can proceed in parallel. P5 can land before or after P4 — until its codes exist, a
Chinese UI shows English error prose (fallback), annoying but correct.

## Non-goals

- Translating the CFCC form template, its baked literals, or the PDF date/amount formats — the
  filed paperwork is an English artifact for the treasurer.
- Translating user data, AI `rationale` text stored in telemetry, `AuditEvent`/`ExtractionLog`
  internals, or server logs.
- Currency localization (`$12.34` everywhere), URL-based locale routing, RTL, and translating
  ministry *values* (as opposed to display labels).

## Open questions for review

1. **zh-Hant single catalog for both Taiwan and Hong Kong** — acceptable? (Vocabulary is
   TW-leaning per the glossary; a `zh-HK` variant later is "one more JSON file".)
2. **Who reviews the Chinese?** One named bilingual reviewer per script keeps the glossary
   coherent.
3. **AI summary language** (§7): steer to the user's language, or keep transcription-neutral?
   This decides what the treasurer reads on the form.
4. **Ministry display labels** (§6): wanted? Can the church supply its official Chinese
   ministry names?
5. **PDF font**: Noto Sans CJK **TC or SC** as the single embedded face (glyph-form default
   for mixed content), and is +16 MB repo/image acceptable? (Both render both scripts'
   *characters*; the choice only sets default glyph style.)
6. **Money display** stays `$12.34` in all locales — confirm.
