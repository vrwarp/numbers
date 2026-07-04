# ⛪ Numbers — CFCC Reimbursement App

**Numbers** is a lightweight, multi-tenant web app that takes the friction out of church expense
reimbursements for Chinese For Christ Church. Snap a photo of a receipt the moment you buy
("Shoebox" model), batch receipts into a claim once a month, let an LLM draft the line items,
verify every row by hand, and download a print-ready PDF of the **official CFCC Invoice Payment /
Expense Reimbursement Form** with all receipts attached.

It self-hosts as a **single Docker container** with SQLite and local file storage — backups are
just a copy of the `/data` folder.

> **Documentation**: [`docs/DESIGN.md`](docs/DESIGN.md) is the full design document for human
> readers (architecture, rationale, decision log). [`docs/agent/`](docs/agent/) plus the root
> [`CLAUDE.md`](CLAUDE.md) are reference docs optimized for AI coding agents (file map, data
> semantics, conventions, testing harness, change playbooks).

## The user journey

1. **Shoebox (capture).** Upload a photo or PDF of a receipt from your phone (installable PWA).
   Images are compressed to ~100 KB on the server; no AI runs at this stage.
2. **Batch & generate.** Select receipts and hit *Generate Claim*. Each receipt goes to a
   vision model via OpenRouter or Google AI Studio (one call per receipt) with a strict prompt:
   line items extracted verbatim, taxes/fees as their own rows, returns/refunds as negative
   quantities and amounts.
3. **Review & validate.** One card per receipt shows the original image beside its editable
   rows, with a live subtotal to match against the printed total. Fix descriptions, change
   ministries, **exclude** personal items, **split** bulk items across ministries (and **merge**
   them back), adjust the tax row. Refund rows are highlighted red. *Generate PDF* stays locked
   until **every** row has been explicitly confirmed — and editing a confirmed row revokes its
   check.
4. **PDF generation.** The backend fills the official form's AcroForm fields (name, address,
   date, line items, total), flattens it, paginates onto extra form pages when a claim exceeds
   the 13-row table, and appends every receipt image/PDF as additional pages. One unified PDF
   downloads to your browser.
5. **Physical signatures.** Print, sign "Requested by", get the pastor/deacon's signature, and
   drop the packet in the Treasurer's inbox.

## Tech stack

| Component | Technology |
| :-- | :-- |
| App, API & auth | Next.js 15 (App Router) + Firebase Authentication (Google sign-in) with a self-issued session cookie |
| Database | SQLite + Prisma — a single `numbers.db` file |
| File storage | Local filesystem under `DATA_DIR` (Docker volume `/data`) |
| Image compression | sharp (~100 KB JPEG target, EXIF-rotation safe) |
| AI parsing | OpenRouter (default) or Google AI Studio / Gemini API (`AI_PROVIDER=google`), strict JSON output validated with zod |
| PDF engine | pdf-lib — fills + flattens the official form's AcroForm fields, merges receipts |

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
npm test              # Vitest unit suite (money, pagination, AI parsing, compression, PDF)
npm run test:e2e      # Playwright end-to-end suite (full journey, security, mobile)
```

The e2e suite builds the app, boots a production server on port 3100 with an isolated database
(`.e2e-data/`), mock AI, and the dev login. It runs a **(desktop, mobile) × (chromium, webkit)**
matrix: the desktop projects cover the complete journey — upload → claim → review
(exclude/split/tax-adjust/verify-all) → PDF download (page count + content assertions) — plus
extraction-log telemetry, multi-tenant isolation, the verification gate, and deletion/discard
housekeeping; the mobile projects (Pixel 7 / iPhone 14) cover the phone-first capture flow.
Screenshots of every screen land in `screenshots/`.

Run `npx playwright install --with-deps chromium webkit` once. To limit engines (e.g. where
WebKit isn't installed) set `E2E_BROWSERS=chromium`; a pre-installed Chromium can be pointed at
with `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome`.

`node scripts/render-pdf.mjs <file.pdf> <out-prefix>` rasterizes a generated packet to PNGs for
eyeballing.

### Continuous integration & delivery

- **`.github/workflows/ci.yml`** — on every PR and push to `main`: the Vitest unit suite plus
  the full Playwright matrix (chromium and webkit jobs, each running desktop + mobile projects).
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
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID` | Firebase web-app config ([console](https://console.firebase.google.com) → Project settings → Your apps). Enable the **Google** provider under Authentication → Sign-in method and add your app's domain to Authentication → Authorized domains. These values are client-safe |
| `FIREBASE_APP_ID` | Optional, from the same Firebase web-app config |
| `AI_PROVIDER` | Extraction backend: `openrouter` (default) or `google` (Google AI Studio / Gemini API) |
| `OPENROUTER_API_KEY` | OpenRouter API key ([openrouter.ai/keys](https://openrouter.ai/keys)) |
| `OPENROUTER_MODEL` | Vision-capable OpenRouter model id, default `google/gemini-3.1-flash-lite` |
| `GEMINI_API_KEY` | Google AI Studio API key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) — used when `AI_PROVIDER=google` |
| `GEMINI_MODEL` | Vision-capable Gemini model id, default `gemini-3.1-flash-lite` |
| `DATA_DIR` / `DATABASE_URL` | Preset in the image (`/data`, `file:/data/numbers.db`) |
| `TEMPLATE_PDF` | Optional path to a replacement blank form (must keep the same AcroForm field names) |
| `AI_MOCK`, `AUTH_TEST_MODE` | Dev/test only — never set in production |

## The official form

`assets/cfcc-form-template.pdf` is the church's real fillable form. The generator fills its
named AcroForm fields (`Make check payable to`, `Description QuantityRow1..13`, `AmountRow1..13`,
`For Ministry  EventRow1..13`, `TotalAmount`, `Requestor Name`, `Request Date`, …) and flattens
the result, so output aligns with the printed form exactly. Claims longer than 13 rows produce
multiple form pages — earlier pages show "(continued)" in the total cell and a page number in
the total row's ministry cell; the grand total appears on the last form page. "Approved by" and
the treasurer section are left blank for ink.

## Data model

- `users` — Firebase identity, full name, mailing address (printed on the form), role
- `receipts` — file path, MIME type, size, status `unassigned → processed`
- `reimbursements` — status `draft → generated`, total in cents
- `line_items` — description, quantity, amount (cents, negative = refund), ministry,
  `is_verified`, `is_excluded`, sort order
- `reimbursement_receipts` — join table linking claims to their receipts
