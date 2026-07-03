# ⛪ Numbers — CFCC Reimbursement App

**Numbers** is a lightweight, multi-tenant web app that takes the friction out of church expense
reimbursements for Chinese For Christ Church. Snap a photo of a receipt the moment you buy
("Shoebox" model), batch receipts into a claim once a month, let an LLM draft the line items,
verify every row by hand, and download a print-ready PDF of the **official CFCC Invoice Payment /
Expense Reimbursement Form** with all receipts attached.

It self-hosts as a **single Docker container** with SQLite and local file storage — backups are
just a copy of the `/data` folder.

## The user journey

1. **Shoebox (capture).** Upload a photo or PDF of a receipt from your phone (installable PWA).
   Images are compressed to ~100 KB on the server; no AI runs at this stage.
2. **Batch & generate.** Select receipts and hit *Generate Claim*. The batch goes to GLM
   (Z.ai / OpenRouter) with a strict prompt: line items extracted verbatim, taxes/fees as their
   own rows, returns/refunds as negative quantities and amounts.
3. **Review & validate.** A side-by-side screen shows the original receipts next to an editable
   grid grouped by receipt, each group with a live subtotal to match against the printed total.
   Fix descriptions, change ministries, **exclude** personal items, **split** bulk items across
   ministries, adjust the tax row. Refund rows are highlighted red. *Generate PDF* stays locked
   until **every** row has been explicitly check-marked — and editing a verified row revokes its
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
| App, API & auth | Next.js 15 (App Router) + NextAuth v5 (Google OAuth) |
| Database | SQLite + Prisma — a single `numbers.db` file |
| File storage | Local filesystem under `DATA_DIR` (Docker volume `/data`) |
| Image compression | sharp (~100 KB JPEG target, EXIF-rotation safe) |
| AI parsing | GLM via Z.ai or OpenRouter (`GLM_MODEL`, default `glm-5.2`), strict JSON output validated with zod |
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
return deterministic fake line items so you can exercise the whole flow offline without Google
or GLM credentials.

### Tests

```bash
npm test              # Vitest unit suite (money, pagination, AI parsing, compression, PDF)
npm run test:e2e      # Playwright end-to-end suite (full journey, security, mobile)
```

The e2e suite builds the app, boots a production server on port 3100 with an isolated database
(`.e2e-data/`), mock AI, and the dev login. It covers the complete journey — upload → claim →
review (exclude/split/tax-adjust/verify-all) → PDF download (page count + content assertions) —
plus multi-tenant isolation, the verification gate, deletion/discard housekeeping, and a
phone-sized viewport. Screenshots of every screen land in `screenshots/`.

If your machine has a pre-installed Playwright Chromium, point at it with
`PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome npm run test:e2e`; otherwise run
`npx playwright install chromium` once.

`node scripts/render-pdf.mjs <file.pdf> <out-prefix>` rasterizes a generated packet to PNGs for
eyeballing.

## Deployment (single container)

```bash
docker build -t numbers .
docker run -d --name numbers -p 3000:3000 \
  -v /volume1/docker/numbers:/data \
  -e AUTH_SECRET="$(openssl rand -base64 32)" \
  -e AUTH_URL="https://numbers.your-church.org" \
  -e GOOGLE_CLIENT_ID="..." -e GOOGLE_CLIENT_SECRET="..." \
  -e GLM_API_KEY="..." \
  numbers
```

or use the provided `docker-compose.yml`. Migrations run automatically on boot.
**Backup = copy the `/data` folder** (database + receipt files).

### Environment variables

| Variable | Purpose |
| :-- | :-- |
| `AUTH_SECRET` | Session signing secret (`openssl rand -base64 32`) — required |
| `AUTH_URL` | Public URL of the app (needed behind a reverse proxy) |
| `GOOGLE_CLIENT_ID/SECRET` | Google OAuth credentials ([console](https://console.cloud.google.com/apis/credentials); redirect URI `<AUTH_URL>/api/auth/callback/google`) |
| `GLM_API_KEY` | Z.ai or OpenRouter API key |
| `GLM_BASE_URL` | `https://api.z.ai/api/paas/v4` (default) or `https://openrouter.ai/api/v1` |
| `GLM_MODEL` | Model id, default `glm-5.2` |
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

- `users` — Google identity, full name, mailing address (printed on the form), role
- `receipts` — file path, MIME type, size, status `unassigned → processed`
- `reimbursements` — status `draft → generated`, total in cents
- `line_items` — description, quantity, amount (cents, negative = refund), ministry,
  `is_verified`, `is_excluded`, sort order
- `reimbursement_receipts` — join table linking claims to their receipts
