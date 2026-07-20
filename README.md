# ⛪ Numbers — CFCC Reimbursement App

**Numbers** is a lightweight, multi-tenant web app that takes the friction out of church expense
reimbursements for Chinese For Christ Church. Snap a photo of a receipt the moment you buy
(the "shoebox" model — the page is simply called **Receipts**), batch receipts into a claim
once a month, let an LLM draft the line items,
verify every row by hand, and download a print-ready PDF of the **official CFCC Invoice Payment /
Expense Reimbursement Form** with all receipts attached. The whole UI is available in **English,
简体中文, and 繁體中文** — and Chinese receipt content prints correctly on the official form.

Or skip the printer entirely: an optional, **cryptographically tamper-evident e-signature
workflow** routes the claim from requestor to approver to treasurer — DocuSign-style
tap-to-sign on the actual form, an in-person vouching ceremony instead of passwords, and an
approval certificate whose QR code lets anyone audit the signatures without an account. It
ships **switched off**; see [Electronic signatures & approvals](#electronic-signatures--approvals).
An optional [push-notification layer](#push-notifications) (also off by default) tells the
right person when a claim is waiting on them, without becoming something the workflow depends on.

It self-hosts as a **single Docker container** with SQLite and local file storage — backups are
just a copy of the `/data` folder.

> **Documentation**: [`docs/DESIGN.md`](docs/DESIGN.md) is the full design document for human
> readers (architecture, rationale, decision log). [`docs/agent/`](docs/agent/) plus the root
> [`CLAUDE.md`](CLAUDE.md) are reference docs optimized for AI coding agents (file map, data
> semantics, conventions, testing harness, change playbooks).

## The user journey

1. **Receipts (capture).** Upload a photo or PDF of a receipt from your phone (installable PWA).
   Images are compressed to ~100 KB on the server; no AI runs at this stage.
2. **Batch & generate.** Select receipts and hit *✨ New Claim*. Each receipt goes to a
   vision model via OpenRouter or Google AI Studio (one call per receipt) with a strict
   transcription prompt: merchant, date, printed total, refund total, and a one-line item
   summary — **one row per receipt**, its amount the printed net (splitting a row is how
   multi-ministry receipts are handled).
3. **Review & validate.** One card per receipt shows the original image beside its editable
   rows, with a live subtotal to match against the printed total. Most claims are for one
   thing, so new claims start in **single-ministry mode**: pick the ministry & event once at
   the top and it applies to every row — or type a one-sentence description ("snacks for the
   youth retreat") and hit **✨ Suggest** to have the AI propose them, informed by your
   church's own vocabulary (see [the church context document](#the-church-context-document)).
   The AI only ever *suggests*; you apply. Switch to *multiple* for per-row ministries. Fix
   descriptions, **exclude** personal items, **split** bulk items across ministries (and
   **merge** them back). Refund rows are highlighted red. *Generate PDF* stays locked until
   **every** row has been explicitly confirmed — and editing a confirmed row revokes its
   check.
4. **PDF generation.** The backend fills the official form's AcroForm fields (name, address,
   date, line items, total), flattens it, paginates onto extra form pages when a claim exceeds
   the 13-row table, and appends every receipt image/PDF as additional pages. One unified PDF
   downloads to your browser. When `PUBLIC_BASE_URL` is configured, every form page is also
   stamped with a **QR code linking back to the packet itself** — an unguessable capability URL
   (`/c/<token>`) that always serves the **latest** generated version, even after the claim is
   reverted to draft, edited, and re-finalized.
5. **Physical signatures.** Print, sign "Requested by", get the pastor/deacon's signature, and
   drop the packet in the Treasurer's inbox. Anyone holding the printed page can scan the QR
   stamp to pull up the digital packet — no sign-in needed, the unguessable link is the
   credential.
6. **…or electronic signatures.** With e-signing enabled, *Submit for approval* replaces the
   printer: the requestor taps to place their hand-drawn signature on the real form, picks an
   approver, and signs; the approver re-verifies everything in their own browser and
   countersigns; the treasurer marks it paid with the check number. Every step is an
   ECDSA-signed event bound to the exact bytes of the frozen packet — see the next section.

## Electronic signatures & approvals

An optional workflow (`draft → generated → submitted → approved → paid`, plus `rejected`)
built on [charproof](https://github.com/vrwarp/charproof): client-side ECDSA identities and
**append-only, encrypted event ledgers on Cloud Firestore**. It is designed for
non-technical members — the most anyone has to do is scan a QR code — while staying
verifiable by a skeptical auditor years later.

- **Signing up is a ceremony, not a password.** A member agrees to sign electronically
  (UETA/ESIGN-style consent), draws their literal signature with a finger or mouse, and then
  gets **vouched for in person**: two members — or one approver — scan the QR on their screen
  and confirm the human in front of them. Vouches are signed roster events; roles
  (approver, treasurer) are separate root-signed grants.
- **You sign the actual document.** The ceremony renders the exact frozen PDF bytes in the
  browser (pdf.js — never a server-produced picture) with a pulsing "Tap to sign" tab on the
  signature line. Nothing is stamped until the signer taps; where they signed travels inside
  the signed payload. Approvals are **fail-closed**: the Approve button physically cannot
  enable until the approver's own browser has re-verified the whole signature chain and
  re-hashed the packet bytes.
- **Tamper-evidence, not secrecy.** Signed packets are archived per-hash and never
  regenerated; any edit voids collected signatures by hash mismatch. The numbers server
  holds **no Firestore credentials** — browsers append events directly under security rules
  that forbid updates, deletes, and backdated timestamps, so not even the server operator can
  rewrite history. The server keeps only a signature-verified mirror for queues and badges.
- **Anyone can audit.** The approval certificate embeds a verification bundle and a QR that
  resolves to `/v/<token>`, where the entire chain is re-verified *in the visitor's browser*
  — no account needed. `scripts/verify-bundle.mjs` is a deliberately independent offline
  reimplementation: given the bundle, the packet, and the church's published root
  fingerprint, it answers `VERIFIED` with no server and no Firestore.
- **A member's identity follows their devices.** Adding a phone is a 6-digit-code ceremony
  between the member's own two devices (the typed code is enforced, not decorative);
  a **printable recovery sheet** (24 words, generated entirely in the browser) restores
  everything on a new device; removing a device rotates the account master key. Losing every
  device just means being re-vouched next Sunday — the new attestation automatically retires
  the old key, and everything it signed stays valid.
- **The admin holds a master switch, OFF by default — and a rollout allowlist.**
  Bootstrapping creates the registry switched off; nothing e-sign-related is visible to
  members until the admin flips it. Even then the scope defaults to **only members the
  admin chooses** (a pilot group), managed from the same card — widen it to everyone with
  one click when ready. Removing someone hides the feature from them; nothing they signed
  changes, and verification of already-signed records never turns off.

The full trust model, ledger thread rules, and attack/defense matrix live in
[`docs/ESIGN_DESIGN.md`](docs/ESIGN_DESIGN.md); multi-device design and its
emulator-found bug list in [`docs/MULTI_DEVICE_PLAN.md`](docs/MULTI_DEVICE_PLAN.md).

### Setting up e-signing (Firebase)

The base app only uses Firebase for Google sign-in; e-signing adds **Cloud Firestore** as the
ledger store. One-time setup on your Firebase project:

1. **Console**: create a Firestore database (Native mode), and under *Authentication* make
   sure the **Google** provider is enabled. To run the rules canary you'll also want the
   **Email/Password** provider with one throwaway user.
2. **Deploy the security rules** — the only Firebase-side deploy this app has (no Hosting, no
   Functions). Note the committed `.firebaserc` points at the emulator's demo project, so
   pass your project explicitly:

   ```bash
   npx firebase login
   npx firebase deploy --only firestore:rules --project <your-project-id>
   ```

3. **Run the canary — the deploy isn't done until it passes.** It proves the hardening fork
   took effect (backdated, malformed, and overwriting event writes are all denied):

   ```bash
   FIREBASE_API_KEY=… FIREBASE_AUTH_DOMAIN=… FIREBASE_PROJECT_ID=… \
   CANARY_EMAIL=… CANARY_PASSWORD=… npm run esign:rules-canary
   ```

4. **Set `ESIGN_ROOT_EMAIL`** to the trust root's account (typically the admin/pastor). Their
   profile gains a one-time *Set up electronic signing* ceremony: keys are generated in their
   browser, the roster's genesis event is self-signed, and the system is created **switched
   off**. They flip the switch when the congregation is ready.
5. After bootstrap, publish the root fingerprint (profile → *Audit details*) somewhere
   out-of-band — the bulletin, the church website — and pin it in the deployment as
   `ESIGN_ROOT_FINGERPRINT`. Clients and the offline verifier refuse any registry that
   doesn't match it.

Dev and CI never need any of this: `ESIGN_MOCK=1` runs the identical protocol (real
cryptography, real ceremonies) on SQLite stores, and the committed e2e suite runs the real
Firestore backend against the **Firebase emulator** — see Tests below.

## Push notifications

Because the app is opened a few times a month, the person who needs to act on a claim often
doesn't know it's waiting. An **optional** push-notification layer (Firebase Cloud Messaging,
web push) closes that gap: the named approver hears that a claim awaits their signature, the
owner hears when it's approved / needs changes / paid, treasurers hear when something's ready
to pay. It ships **switched off**, is opt-in per person, and is designed to *never* be
load-bearing — a member with notifications off has exactly today's experience.

- **An acceleration layer, not a source of truth.** The in-app badges and a new home-page
  **activity list** stay authoritative and sufficient; push just delivers the same facts
  sooner. Every event is recorded for the activity list regardless of anyone's push
  preferences, so a member with notifications off still sees "Your claim was approved" the
  next time they open the app — push merely delivers it to their lock screen first.
- **Opt-in, with an honest on-ramp.** Turning it on happens on the profile page behind a
  soft-ask that names what you'll be told about and the one reliable off-switch, *then* asks
  the browser's permission. The card never shows a dead toggle: WeChat/Line in-app browsers
  are told to open in Safari, an iPhone is walked through *Add to Home Screen* first (iOS only
  delivers web push to an installed app), and an iOS version too old to support it says so
  plainly. Categories (signing / my claims / payments / security) are individually toggleable
  and only shown to people they can fire for.
- **Lock screens stay discreet.** Payloads carry a title, a short label, and a tap route —
  **never** dollar amounts, reviewer notes, or a claim's free-text description. An optional
  *discreet previews* mode makes them fully outcome- and name-neutral for shared family
  devices. Whether a notification was delivered, seen, or tapped is never recorded.
- **The trust model is preserved.** The e-sign design keeps the server unable to touch the
  Firestore ledger. Sending push needs a Google service account — so this one uses a **custom
  IAM role holding exactly `cloudmessaging.messages.create`** and nothing else; it can send
  messages but cannot read or write Firestore. The admin health card verifies that scope and
  warns in red if the account can do more.

The full contract (event catalog, delivery pipeline, preference model, trust amendments) is in
[`docs/NOTIFICATIONS_DESIGN.md`](docs/NOTIFICATIONS_DESIGN.md).

### Setting up push (Firebase)

Entirely optional — leave it unconfigured and the app runs exactly as before (badges and the
activity list are the baseline). The step-by-step console walkthrough, written for someone who
has never opened the Google Cloud IAM screen, is [`docs/PUSH_SETUP.md`](docs/PUSH_SETUP.md); in
short:

1. **Firebase console → Project settings → Cloud Messaging**: copy the **Sender ID**
   (`FIREBASE_MESSAGING_SENDER_ID`) and generate a **Web Push certificate** key pair
   (`FIREBASE_VAPID_PUBLIC_KEY`). Both are client-safe.
2. **Google Cloud → IAM & Admin → Roles → Create role** *first*: add exactly the one
   permission `cloudmessaging.messages.create`. Then create a **service account**, grant it
   *only* that custom role, and download a JSON key. Never grant "Firebase Admin" — a broad
   role would let the server touch the signature ledger and void the e-sign trust model (the
   admin health card checks for this).
3. Paste the values into **Admin → Settings → Push** (the service-account JSON is
   multi-line, so `<DATA_DIR>/config.json` / the admin editor is its home, not shell env).
   The health card should read *Sending*; then **Profile → Notifications → Send myself a
   test**.

iPhones receive push only from the installed Home-Screen app (iOS 16.4+), so the
`FIREBASE_AUTH_PROXY` sign-in fix below is a practical prerequisite there. Dev and tests never
need any of this: **`PUSH_MOCK=1`** records deliveries to a local file instead of FCM and
registers synthetic tokens, so the whole pipeline runs offline.

## Languages — English · 简体中文 · 繁體中文

The UI ships in English, Simplified Chinese (mainland-China audience), and Traditional Chinese
(Taiwan/Hong Kong audience — real Taiwan vocabulary, not a character conversion of the
Simplified catalog). A language picker sits in the nav bar and on the sign-in page; the choice
is kept in a cookie, persisted to the account, and restored at sign-in on a new device.
First-time visitors get their browser's language.

Untranslated on purpose: the official CFCC form itself (the treasurer's document), ministry
names (the church's chart of accounts — stored data, printed on the form, and the
AI-suggestion vocabulary), money (`$12.34` in every language), and anything a user typed.
Chinese **content** — descriptions, names, receipt notes — renders correctly on the generated
PDF through an embedded CJK font subset; without it, non-Latin text printed as "…".

### Maintaining translations

`messages/en.json` is the source of truth; `zh-Hans.json` / `zh-Hant.json` mirror it. The
guard rails: a typo'd key fails `npm run build` (keys are typed against the English catalog);
a missing translation, a reworded English string, or wording that drifted between linked keys
fails `npm test`. To update:

```bash
npm run translate              # draft missing/stale keys via the configured AI provider
npm run translate -- --todo    # no AI key: fill with English placeholders instead
```

`messages/translation-state.json` records, per key, the verbatim English source, an optional
translator hint (`context`), and a per-locale review status (`todo → machine → reviewed`) — a
bilingual reviewer edits the catalog value and flips the status, and reviewed keys are never
overwritten without `--force`. Terminology lives in [`messages/GLOSSARY.md`](messages/GLOSSARY.md);
wording shared across screens is declared (`SAME_VALUE_GROUPS` / `QUOTED_IN` in
`src/lib/translation-state.ts`) and test-enforced in every language. Both Chinese catalogs are
currently machine drafts awaiting review by a native speaker.

## Tech stack

| Component | Technology |
| :-- | :-- |
| App, API & auth | Next.js 15 (App Router) + Firebase Authentication (Google sign-in) with a self-issued session cookie |
| Database | SQLite + Prisma — a single `numbers.db` file |
| File storage | Local filesystem under `DATA_DIR` (Docker volume `/data`) |
| Image compression | sharp (~100 KB JPEG target, EXIF-rotation safe) |
| AI parsing | OpenRouter (default) or Google AI Studio / Gemini API (`AI_PROVIDER=google`), strict JSON output validated with zod |
| PDF engine | pdf-lib — fills + flattens the official form's AcroForm fields, merges receipts; CJK values drawn with a bundled Noto face (subset-embedded via fontkit) |
| Localization | next-intl — `en` / `zh-Hans` / `zh-Hant` catalogs in `messages/`, typed keys, AI-drafted + human-reviewed translation pipeline |
| E-signatures | [charproof](https://github.com/vrwarp/charproof) (client-side ECDSA identities, AMK multi-device keystore, phrase/passkey recovery) over append-only encrypted ledgers on Cloud Firestore; pdf.js renders the packet in-browser for tap-to-sign; all verification re-runs client-side (the server never holds Firestore credentials) |
| Push notifications | Firebase Cloud Messaging web push (optional, opt-in); a durable outbox + in-process worker mirror the search-index queue; sent via a messaging-only service account; the service worker is served as a route (runtime config, no build-time secrets) |

Money is stored as **integer cents** everywhere; users only ever see dollars.

## Development

```bash
cp .env.example .env          # then uncomment AI_MOCK / AUTH_TEST_MODE for offline dev
npm install
npx prisma migrate dev        # creates ./data/numbers.db
npm run dev                   # http://localhost:3000
```

With `AUTH_TEST_MODE=1` you get a passwordless dev login, and `AI_MOCK=1` makes claim generation
return deterministic fake line items so you can exercise the whole flow offline without Firebase
or AI-provider credentials.

### Tests

```bash
npm test                    # Vitest unit suite (money, pagination, AI parsing, compression,
                            #   PDF, e-sign protocol rules, translations)
npm run test:e2e            # Playwright end-to-end suite (full journey, security, mobile)
npm run test:e2e:esign:local  # e-sign suite on the REAL Firestore backend (Firebase emulator;
                              #   needs Java) — or :docker for the containerized CI variant
```

The e2e suite builds the app, boots a production server on port 3100 with an isolated database
(`.e2e-data/`), mock AI, and the dev login. It runs a **(desktop, mobile) × (chromium, webkit)**
matrix: the desktop projects cover the complete journey — upload → claim → review
(exclude/split/tax-adjust/verify-all) → PDF download (page count + content assertions) — plus
extraction-log telemetry, multi-tenant isolation, the verification gate, and deletion/discard
housekeeping; `i18n.spec.ts` covers language switching and its persistence (the rest of the
suite runs pinned to English); the mobile projects (Pixel 7 / iPhone 14) cover the phone-first
capture flow.
Screenshots of every screen land in `screenshots/`.

The **e-sign suite** (`tests/esign-e2e/`, own config, port 3101) is one strictly serial
multi-context story on the **real** Firestore backend under `firebase emulators:exec` — the
production security rules, real charproof custody, no e-sign mock: bootstrap and the master
switch, enrollment and in-person vouching, submit → approve → paid, public verification, a
phone joining by typed code and signing a claim, the printed recovery sheet, phrase recovery,
device revocation (asserting the key rotation committed server-side), and lost-everything
start-over with re-vouch key supersession.

Run `npx playwright install --with-deps chromium webkit` once. To limit engines (e.g. where
WebKit isn't installed) set `E2E_BROWSERS=chromium`; a pre-installed Chromium can be pointed at
with `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome`.

`node scripts/render-pdf.mjs <file.pdf> <out-prefix>` rasterizes a generated packet to PNGs for
eyeballing.

### Continuous integration & delivery

- **`.github/workflows/ci.yml`** — on every PR and push to `main`: the Vitest unit suite plus
  the full Playwright matrix (chromium and webkit jobs, each running desktop + mobile projects),
  plus the **e-sign job**, which builds `Dockerfile.e2e` (Playwright image + Java) and runs the
  e-sign suite inside it against the Firebase emulators — emulator jars cached between runs.
  Playwright reports are uploaded as artifacts on failure.
- **`.github/workflows/docker.yml`** — on PRs the image is built as a **dry run** (never
  pushed); on merge to `main` it is built and pushed to Docker Hub as
  `<DOCKERHUB_USERNAME>/numbers:latest` and `:sha-<commit>`. Configure two repository secrets:
  `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (an access token with write scope).

## AI telemetry for prompt tuning

Every extraction call and every human correction is recorded, so the extraction prompt can be tuned
against real data:

- **`extraction_logs`** — one row per extraction call (including failures): model, the exact
  prompt, receipt metadata, the raw model response, the parsed items, status/error, duration.
- **`line_items.original*`** — a frozen snapshot of what the AI extracted for each row;
  comparing it to the final values shows what the human fixed.
- **`audit_events`** — a chronological trail of each manual edit with field-level
  before/after diffs (`update`), plus `split` events.

API (scoped to the signed-in user):

- `GET /api/extraction-logs[?reimbursementId=…]` — list call summaries
- `GET /api/extraction-logs/:id` — full tuning record: prompt, raw response, parsed items,
  final line items with per-field `corrections` (AI value → human value, `humanCreated` flag
  for split-added rows), and the audit trail

For bulk analysis across all users, query the SQLite file in `/data` directly — e.g.
`sqlite3 data/numbers.db "SELECT prompt, rawResponse FROM ExtractionLog WHERE status='success'"`.

## Deployment (single container)

```bash
docker build -t numbers .
docker run -d --name numbers -p 3000:3000 \
  -v /volume1/docker/numbers:/data \
  -e AUTH_SECRET="$(openssl rand -base64 32)" \
  -e FIREBASE_API_KEY="..." \
  -e FIREBASE_AUTH_DOMAIN="your-project.firebaseapp.com" \
  -e FIREBASE_PROJECT_ID="your-project" \
  -e OPENROUTER_API_KEY="..." \
  numbers
```

or use the provided `docker-compose.yml`. Migrations run automatically on boot.
**Backup = copy the `/data` folder** (database + receipt files).

### Environment variables

Every setting below **except `DATA_DIR` / `DATABASE_URL`** can also be supplied by a JSON file at
`<DATA_DIR>/config.json` (i.e. `/data/config.json` in the container) instead of — or on top of —
process env vars:

```json
{ "AI_PROVIDER": "google", "GEMINI_API_KEY": "...", "AI_RPM_TARGET": "10" }
```

File values **override** the corresponding env vars and are re-read whenever the file changes, so a
running deployment can be reconfigured (swap the AI provider, rotate a key) by editing a file on the
`/data` volume — no container restart or redeploy. `DATA_DIR` is exempt because it locates the file
itself, and `DATABASE_URL` is read directly by Prisma. Since the file can hold secrets, it lives on
the same volume as the database and receipts — keep it out of version control.

See [`config.json.example`](config.json.example) for a full template (`cp config.json.example
/data/config.json` and fill in your values).

| Variable | Purpose |
| :-- | :-- |
| `AUTH_SECRET` | Session-cookie signing secret (`openssl rand -base64 32`) — required |
| `PUBLIC_BASE_URL` | The URL users reach the deployment at, e.g. `https://numbers.example.org`. Enables the QR self-link stamp on generated PDFs (the server can't infer its public origin behind Docker/reverse proxies). Unset → PDFs are generated without the stamp |
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID` | Firebase web-app config ([console](https://console.firebase.google.com) → Project settings → Your apps). Enable the **Google** provider under Authentication → Sign-in method and add your app's domain to Authentication → Authorized domains. These values are client-safe |
| `FIREBASE_APP_ID` | Optional, from the same Firebase web-app config |
| `FIREBASE_AUTH_PROXY` | Set to `1` to fix Google sign-in on iOS/WebKit by serving Firebase's sign-in helper from this app's own origin (see [iOS / in-app-browser sign-in](#ios--in-app-browser-sign-in) below). Requires `PUBLIC_BASE_URL` plus two console entries |
| `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_VAPID_PUBLIC_KEY` | Optional [push notifications](#push-notifications) — the client-safe half (Firebase console → Cloud Messaging). Unset → the feature stays dormant |
| `FCM_SERVICE_ACCOUNT_JSON` | The push **sending** credential: a service account whose custom IAM role holds only `cloudmessaging.messages.create` (never "Firebase Admin"). Multi-line JSON — best supplied via `config.json` / the admin editor. Write-only; never returned by any API |
| `NOTIFY_PAUSED` | Set to `1` to stop all push sending without a redeploy (events keep recording); the deployment kill-switch |
| `NOTIFY_QUIET` | Optional hold-then-send window for claim notifications, e.g. `21:30-08:00,sun:09:00-12:30` (server time). Off by default — device Do-Not-Disturb is usually the better tool. Device security alerts are never held |
| `AI_PROVIDER` | Extraction backend: `openrouter` (default) or `google` (Google AI Studio / Gemini API) |
| `OPENROUTER_API_KEY` | OpenRouter API key ([openrouter.ai/keys](https://openrouter.ai/keys)) |
| `OPENROUTER_MODEL` | Vision-capable OpenRouter model id, default `google/gemini-3.1-flash-lite` |
| `GEMINI_API_KEY` | Google AI Studio API key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) — used when `AI_PROVIDER=google` |
| `GEMINI_MODEL` | Vision-capable Gemini model id, default `gemini-3.1-flash-lite` |
| `ESIGN_ROOT_EMAIL` | Enables e-signing setup: the account allowed to run the one-time registry bootstrap (the trust root — see [Electronic signatures & approvals](#electronic-signatures--approvals)). Unset → the e-sign feature stays dormant |
| `ESIGN_ROOT_FINGERPRINT` | Optional but recommended once bootstrapped: the published root key fingerprint. Clients, the server, and the offline verifier refuse a registry that doesn't match it |
| `CHURCH_CONTEXT_PATH` | Optional path to [the church context document](#the-church-context-document); default `<DATA_DIR>/church-context.md` |
| `DATA_DIR` / `DATABASE_URL` | Preset in the image (`/data`, `file:/data/numbers.db`) |
| `TEMPLATE_PDF` | Optional path to a replacement blank form (must keep the same AcroForm field names) |
| `CJK_FONT_PATH` | Optional replacement font for Chinese text on generated PDFs (default: the bundled Noto Sans CJK face) |
| `AI_MOCK`, `AUTH_TEST_MODE`, `ESIGN_MOCK`, `PUSH_MOCK`, `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST` | Dev/test only — never set in production (`PUSH_MOCK=1` records push deliveries to a local file instead of FCM) |

### iOS / in-app-browser sign-in

Firebase's default Google sign-in loads a cross-origin iframe (and, for redirects, a
navigation) from the `*.firebaseapp.com` **authDomain**. On iOS *every* browser is WebKit,
and WebKit partitions third-party storage — so that cross-origin helper can't reach its own
`sessionStorage`. The result is Google sign-in failing with `auth/popup-blocked` on the first
tap, or the redirect landing on `Unable to process request due to missing initial state`.

Setting **`FIREBASE_AUTH_PROXY=1`** fixes this by serving Firebase's sign-in helper from your
**own** origin instead. The app reverse-proxies `/__/auth/*` and `/__/firebase/*` to your
project's `<FIREBASE_PROJECT_ID>.firebaseapp.com` handler and points the client `authDomain` at
`PUBLIC_BASE_URL`'s host, so the sign-in iframe/redirect is first-party and storage partitioning
no longer applies.

To enable it:

1. Set `FIREBASE_AUTH_PROXY=1` and make sure `PUBLIC_BASE_URL` is your real public origin
   (e.g. `https://numbers.example.org`).
2. **Google Cloud → APIs & Services → Credentials →** your OAuth 2.0 client → add
   `https://<your-host>/__/auth/handler` to **Authorized redirect URIs**.
3. **Firebase → Authentication → Settings → Authorized domains →** add `<your-host>`.

Leave `FIREBASE_AUTH_DOMAIN` as `your-project.firebaseapp.com` — **don't** change it to your own
domain; the proxy's upstream is derived from `FIREBASE_PROJECT_ID`, so pointing `authDomain` at
your own host would only make the proxy call itself. (A non-standard project can override the
upstream with `FIREBASE_AUTH_UPSTREAM_HOST`.) Leave `FIREBASE_AUTH_PROXY` unset to keep the
default `*.firebaseapp.com` flow (no console changes needed). Either way, **in-app browsers** (Messenger, Instagram, …) still can't complete
Google sign-in — Google [blocks OAuth in embedded webviews](https://developers.googleblog.com/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/)
outright — so the sign-in screen detects them and prompts the user to open the page in Safari or
Chrome.

### The church context document

The review screen's **✨ Suggest** button turns a one-sentence claim description ("snacks for
the youth retreat") into a proposed ministry & event. Out of the box the AI only knows the
chart of accounts, which can't resolve church-specific shorthand — which fellowship "Ember"
is, that "the retreat" means the Summer Retreat, that building paper goods aren't Office
Supplies. That knowledge lives in a small markdown file **you** (the operator) maintain on the
data volume, prepended to every Suggest prompt:

```bash
cp docs/church-context.example.md /data/church-context.md   # then edit for your church
```

The [template](docs/church-context.example.md) shows the three kinds of content that help:
**vocabulary & aliases** (group names, nicknames), **recurring events** (name + rough season),
and **labeling rules** ("food purchases default to Luncheon Catering unless tied to a named
event"). Don't list the budget categories themselves — the app already sends the chart of
accounts with every request.

Operational notes:

- The file is re-read on **every** Suggest call, so edits apply immediately — no restart.
- If the file is missing or empty, Suggest still works with chart-of-accounts knowledge only.
- Keep it small (it rides along on every request; capped at 16 KB). The default location is
  `/data/church-context.md`; override with `CHURCH_CONTEXT_PATH`.
- **Privacy**: the file's full contents are sent to your configured AI provider with every
  Suggest request (receipt images already go to the same provider). Think twice before naming
  individuals.

## The official form

`assets/cfcc-form-template.pdf` is the church's real fillable form. The generator fills its
named AcroForm fields (`Make check payable to`, `Description QuantityRow1..13`, `AmountRow1..13`,
`For Ministry  EventRow1..13`, `TotalAmount`, `Requestor Name`, `Request Date`, …) and flattens
the result, so output aligns with the printed form exactly. Claims longer than 13 rows produce
multiple form pages — earlier pages show "(continued)" in the total cell and a page number in
the total row's ministry cell; the grand total appears on the last form page. "Approved by" and
the treasurer section are left blank for ink. Values the form's built-in Helvetica can't encode —
Chinese descriptions, names, receipt notes — are drawn with a bundled Noto CJK face instead,
embedded as a subset (a packet grows by kilobytes, not the font's 16 MB). When the QR
self-link stamp is enabled, the "Note:" box is redrawn slightly narrower at generation time
(same text, re-flowed) and the QR code is placed in the freed space beside it — the bundled
template file itself is never modified.

## Data model

- `users` — Firebase identity, full name, mailing address (printed on the form), role
  (mirrored from signed roster events), UI language (`locale`), and per-user
  notification preferences (`notify*` — master switch + category toggles, off by default)
- `receipts` — file path, MIME type, size, status `unassigned → processed`, extraction-stamped
  merchant/date/printed totals
- `reimbursements` — status `draft → generated` (+ e-sign: `submitted | rejected | approved |
  paid`), total in cents, QR capability token, signature-ledger pointer + packet hash
- `line_items` — description, amount (cents, negative = refund), ministry & event,
  `is_verified`, `is_excluded`, sort order, frozen `original*` AI values
- `reimbursement_receipts` — join table linking claims to their receipts
- e-sign tables — the registry (roster pointer + master switch), per-member signer identities
  (verified mirror + drawn signature), raw ledger-event mirrors, signature records, and the
  per-hash archive ledger that keeps signed packets verifiable even after a claim is deleted;
  `Esign*` mock stores stand in for Firestore in dev/tests only
- push tables — `push_tokens` (one FCM registration token per device, owner-scoped, never
  returned by any API) and `notification_jobs` (the durable outbox, which also backs the
  in-app activity list; 90-day retention)
