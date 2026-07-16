# Semantic search across receipts and claims — design

Status: **proposed** (embedding endpoint contract pending — see §12 Open questions).
Companion to `docs/ESIGN_DESIGN.md` (this feature amends its §6.3 read-grant list) and
`docs/agent/DATA_MODEL.md` (three new tables).

## 1. Goal

Let users find receipts and claims by meaning, not exact text: "the projector we bought
for VBS", "that Costco run with the returned chairs", "王姐妹's retreat snacks".

- **Members** search their own receipts and their own claims.
- **Approvers** search **all** receipts and **all** claims, with a filter for
  "claims I decided" (approved or rejected by them).
- **Treasurers** (and admins) search **all** receipts and **all** claims.
- Results are ranked by cosine similarity of a Qwen multimodal embedding and presented
  **grouped by year**, best match first within each year.
- **All claims are indexed, drafts included**: a draft becomes searchable once it has
  been left unchanged for **10 minutes** (a debounce, so active editing never burns
  10 s embeds on every keystroke — §5.2); frozen claims index immediately.
- The embedding backend (endpoint, model, dimension) is **operator-changeable from the
  admin interface at runtime**, including a safe migration path to a new model (§3.3).

Two latency constraints drive the architecture:

| Operation | Latency | Consequence |
| :-- | :-- | :-- |
| Embed a search query (text) | ~500 ms | Query embedding happens synchronously per search; the UI is designed around an explicit-submit, sub-second search — never per-keystroke |
| Embed a receipt image / claim PDF | ~10 s | Document embedding is NEVER done in a request path. A durable SQLite-backed job queue with retry embeds items in the background as they appear, plus a backfill sweep for pre-existing items |

## 2. Non-goals

- No external services. The queue is a SQLite table worked by the existing single Node
  process — same "no queue, no cache, no other services" posture as the rest of the app.
- No vector database / SQLite extension. At church scale (thousands of receipts, hundreds
  of claims) brute-force cosine over an in-memory Float32 matrix is milliseconds; sqlite-vec
  et al. are complexity we don't need. Revisit only if corpus size × dim makes the resident
  matrix a memory problem (see §6.3).
- No keyword/substring search engine. This is purely embedding search; the existing list
  screens keep their filters.
- No instant indexing of in-flight drafts: a draft under active edit is only re-embedded
  after 10 idle minutes (§5.2) — mid-edit staleness of up to that window is accepted.

## 3. Embedding backend

### 3.1 Provider contract

A self-hosted Qwen multimodal embedding endpoint, **most likely OpenAI-compatible**
(`POST <base>/v1/embeddings` with `{model, input}` → `{data: [{embedding: [...]}]}`).
The provider module defaults to that shape, with image inputs sent the way
OpenAI-compatible multimodal embedding servers (e.g. vLLM) accept them — a data-URI /
`image_url` content part. The integration is isolated behind one module so whatever the
final contract turns out to be only touches one file:

```
src/lib/embeddings/provider.ts     embedText(text, cfg) / embedImage(bytes, mime, text?, cfg)
                                   → Float32Array(cfg.dim), L2-normalized.
                                   cfg = a ModelConfig (§3.2) — the provider is
                                   STATELESS about which model is current, so the
                                   migration worker can drive two models at once
src/lib/embeddings/mock.ts         EMBEDDING_MOCK=1 — deterministic hash-based vectors
                                   (token-bag folded into the vector space so that
                                   "costco" query ≈ costco fixture; no network).
                                   Vectors are salted with cfg.model so two mock
                                   "models" are deliberately incompatible — tests
                                   exercise the migration machinery for real
```

Normalization rule: **provider.ts always returns unit vectors**. Everything downstream
(storage, scoring) assumes it; cosine similarity becomes a plain dot product. The
provider also **verifies the returned length equals `cfg.dim`** and errors otherwise —
misconfiguration fails loudly at the probe/job, never as silent garbage scores.

### 3.2 Runtime-editable settings (admin), env as seed

Everything about the backend is changeable from `/admin` without a redeploy. Settings
live in a single-row table (same pattern as `EsignRegistry`), NOT in env:

```prisma
// Single row (app-enforced). The admin-editable embedding backend config.
// active* is what search + normal ingest use; target* is non-null only while
// a model migration (§3.3) is in flight.
model EmbeddingSettings {
  id             String   @id @default(cuid())
  enabled        Boolean  @default(false)
  activeEndpoint String   @default("")
  activeApiKey   String   @default("")   // stored in SQLite on the /data volume —
                                         // same trust domain as everything else there
  activeModel    String   @default("")
  activeDim      Int      @default(0)
  // Query-side instruction prefix (Qwen embedding models score better with one);
  // editable because it is model-specific. Changing it only affects queries —
  // no re-index needed, but the query LRU keys on it (§6.1).
  queryPrefix    String   @default("")
  targetEndpoint String?
  targetApiKey   String?
  targetModel    String?
  targetDim      Int?
  targetQueryPrefix String?
  migrationState String   @default("none") // none | indexing | ready
  updatedAt      DateTime @updatedAt
}
```

Resolution order, read through one accessor (`embeddingSettings()`):
**DB row → seeded on first read from `EMBEDDING_*` config values** (which themselves
resolve config.json → env, per the existing `configValue()` chain). After that first
seed, the DB row is authoritative and the admin UI is the way to change it — env edits
no longer override silently (the admin card shows a hint when env and DB disagree).
`EMBEDDING_MOCK=1` short-circuits everything (tests/dev).

| Var (seed only) | Notes |
| :-- | :-- |
| `EMBEDDING_ENDPOINT` | OpenAI-compatible base URL; feature is OFF until some config exists (no nav entry, routes 404, worker idle) |
| `EMBEDDING_API_KEY` | optional bearer token |
| `EMBEDDING_MODEL` | model id string, stored on every vector row |
| `EMBEDDING_DIM` | vector dimension |
| `EMBEDDING_QUERY_PREFIX` | optional instruction prefix for query embeds |
| `EMBEDDING_TIMEOUT_MS` | default 30000 (not in DB — plumbing, not policy) |
| `EMBEDDING_DRAFT_IDLE_MS` | default 600000 — the 10 min draft-idle debounce (§5.2); tests shrink it |
| `EMBEDDING_MOCK=1` | deterministic vectors, no network |

Admin edits are validated by a **live probe** before saving: embed a fixed test string
against the entered endpoint/model, check HTTP success and that the vector length
matches the entered dim (a "Test connection" button runs the same probe standalone).
Every settings change writes an `AuditEvent` (`action="update-embedding-config"`,
detail = field diff **with the API key redacted to a fingerprint**).

### 3.3 Changing the model — the migration lifecycle

A model change is never a hot swap: query vectors are only comparable to document
vectors from the **same model**, so flipping the model string would instantly make the
whole index unscoreable until a multi-hour re-embed finished. Instead, changing model
(or endpoint or dim) in the admin UI starts a **shadow re-index with an explicit
cutover**, during which search keeps working on the old model:

```
none ──(admin saves new backend; probe passes)──▶ indexing ──(coverage 100%)──▶ ready
 ▲                                                   │                            │
 └────────────(admin cancels: target rows/jobs deleted)◀──────────────────────────┤
 └────────────(admin clicks "Cut over": active←target, old rows deleted)◀─────────┘
```

- **indexing**: `target*` fields are set; the backfill sweep (§5.4) enqueues a re-embed
  of every indexable item for the target model at priority 1. Live triggers (§5.2)
  enqueue **both** models during a migration, so items created mid-migration have no
  coverage hole at cutover. Queries and scoring still use `active*` exclusively —
  search quality is untouched while the shadow index builds.
- **ready**: target coverage reached 100% (sweep finds nothing missing). The admin card
  enables **Cut over** — an explicit click, not automatic, so the operator can A/B a
  few searches first via the card's "preview search with new model" box (runs a normal
  query but scores against target-model rows; admin-only, read-only). If they prefer
  hands-off, a "cut over automatically when ready" checkbox covers it.
- **Cut over**: transactionally `active* ← target*`, `target* ← null`, state `none`;
  then delete `Embedding` rows and jobs of the old model and bump the index-cache
  version. Query LRU entries key on model (§6.1) so stale cached query vectors are
  unreachable, not just unlikely. Rollback after cutover = run a migration back to the
  old settings (the machinery is symmetric; old vectors were deleted, so it re-embeds —
  keeping them would double storage for a rare event, not worth it).
- **Cancel** (any time before cutover): delete target-model rows/jobs, clear `target*`.

Non-obvious invariant this buys: **`Embedding.model` (and the job's `model`) is part of
the row identity** — uniqueness is `(kind, targetId, model)`, the search index loads
only `activeModel` rows, and the worker embeds with whatever model the *job* names, not
"the current model". All migration behavior falls out of those three rules.

## 4. Data model

Three new tables (append to `prisma/schema.prisma`; migration committed as usual):
`EmbeddingSettings` (§3.2), plus the vector store and the queue below. Vectors live in
their own table, not columns on Receipt/Reimbursement, so a model change is row churn
rather than schema surgery, and so the join-free scan the search path does (§6.3)
stays cheap.

```prisma
// One vector per indexed document per model. During a model migration (§3.3)
// a document briefly has two rows — the active model's and the target's.
// targetId is a Receipt.id or Reimbursement.id (plain string, no FK — rows are
// deleted by the ingest code alongside their target, and the queue must be
// able to reference not-yet-indexed targets).
model Embedding {
  id           String   @id @default(cuid())
  kind         String   // "receipt" | "claim"
  targetId     String
  // Denormalized owner + year, so the search path scans ONE table with no joins
  // and applies tenant scoping before any vector math.
  userId       String
  year         Int      // grouping key (see §6.4 for how it is derived)
  model        String   // which backend produced the vector — part of row identity
  dim          Int
  vector       Bytes    // Float32Array little-endian, L2-normalized, length == dim
  // Fingerprint of the exact bytes/text that were embedded — staleness detector.
  // Receipts: sha256 of the stored image file. Claims: sha256 of the text
  // composite (§5.1) — uniform across drafts and frozen claims.
  sourceSha256 String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([kind, targetId, model])
  @@index([model, userId])
}

// Durable work queue. One live row per (kind, targetId, model); re-triggering
// an already-queued item updates it in place rather than growing the queue.
model EmbeddingJob {
  id            String    @id @default(cuid())
  kind          String    // "receipt" | "claim"
  targetId      String
  model         String    // embed with THIS model (active, or target mid-migration)
  status        String    @default("queued") // queued | running | done | failed
  // 0 = live event (new upload / new packet), 1 = backfill/migration. The worker
  // drains priority 0 first so fresh items don't wait behind a 3-hour sweep.
  priority      Int       @default(0)
  attempts      Int       @default(0)
  nextAttemptAt DateTime  @default(now())
  // Crash-safety lease: a "running" row whose lease has expired is reclaimable.
  leaseExpiresAt DateTime?
  lastError     String    @default("")
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@unique([kind, targetId, model])
  @@index([status, priority, nextAttemptAt])
}
```

Deletion: the receipt DELETE route and claim DELETE route also delete the matching
`Embedding` + `EmbeddingJob` rows — all models' rows (no FK cascade — do it in the
route transaction).

## 5. Ingest pipeline (the 10 s path)

### 5.1 What gets embedded

**Receipts — the stored image.** Input to `embedImage()` is the already-compressed
stored file (`filePath`, ~100 KB WebP — plenty for an embedding; never the original).
If the endpoint accepts an optional text pairing, send the user's `note` +
extracted `merchant` alongside the pixels. PDF receipts embed their **page-1 raster**,
reusing the existing preview machinery (`src/lib/pdf/preview.ts` cache; generate on
demand if not yet cached).

**Claims — a text composite of the claim's content + first receipt image.**
The naïve reading of "embed the claim PDF" — rasterize the form page — would be a
mistake: every form page is 90% identical AcroForm boilerplate, so all claims would
cluster together and similarity would be dominated by the template, not the content.
Instead the claim's embedding input is a **structured text composite** of the claim's
content (for a frozen claim, exactly what the packet contains), optionally paired with
the first receipt image if the endpoint supports text+image inputs:

```
Reimbursement claim by <fullName>. <claimDescription>.
Ministries: <distinct formatMinistryEvent values>.
Items: <description> ($<amount>); <description> ($<amount>); …
Merchants: <distinct receipt merchants>. Total $<total>. <MM/YYYY>.
```

(Amounts formatted at this boundary via `src/lib/money.ts`, like the LLM boundary.)
`sourceSha256` for a claim is the **sha256 of the composite text itself** — the
fingerprint of exactly what was embedded. This works uniformly for drafts (no packet
exists) and frozen claims, and makes staleness checks trivial: rebuild the composite,
compare hashes. Excluded rows are left out of the composite, so excluding/restoring is
a content change like any other.

### 5.2 Triggers (event-driven — items embed "as soon as available")

| Event | Action |
| :-- | :-- |
| Receipt uploaded (`POST /api/receipts`) | enqueue `{kind:"receipt"}`, priority 0 |
| Receipt image edited / restored (`/api/receipts/[id]/edit`) | re-enqueue (file bytes changed ⇒ `sourceSha256` stale) |
| Any draft-claim content mutation (claim created, claim PATCH, line-item PATCH/split/merge, receipts added/removed, manual entry) | enqueue `{kind:"claim"}`, priority 0, **`nextAttemptAt = now + 10 min`** — the draft-idle debounce, see below |
| Claim PDF generated (`POST …/pdf`) | re-enqueue `{kind:"claim"}` with `nextAttemptAt = now` (content is frozen; index immediately); regeneration likewise |
| Claim reverted to draft | re-enqueue with the draft debounce (the claim stays searchable; its embedding refreshes if post-revert edits change content) |
| Receipt / claim deleted | delete `Embedding` + job rows (all models) |

Every enqueue targets the **active** model — and additionally the **target** model
while a migration is `indexing`/`ready` (§3.3), so cutover has no coverage holes.

**The draft-idle debounce costs no new machinery** — it is the queue's own upsert
semantics: every draft mutation re-upserts the job with `nextAttemptAt = now + 10 min`,
so continuous editing keeps pushing the embed into the future, and the job only becomes
runnable once the draft has sat untouched for 10 minutes. Two guards keep it honest:
the worker embeds whatever the claim contains *at run time* (never a snapshot from
enqueue time), and an enqueue-upsert that lands while the same job is `running`
re-queues it, so an edit racing a 10 s embed just schedules a follow-up whose hash
check makes it cheap. The window is `EMBEDDING_DRAFT_IDLE_MS` (default 600000).
All draft mutation paths already write the claim row (`totalCents` recompute /
`updatedAt`), so the trigger list above is exactly the routes that must call
`enqueueClaimEmbedding()` — a new mutation route joining invariant-7's telemetry duty
also joins this one.

"Enqueue" = upsert on `(kind, targetId, model)`: reset `status="queued"`, `attempts=0`,
set `nextAttemptAt` as the trigger dictates, keep/raise priority. Never blocks or fails
the calling route — queue write errors are logged and swallowed (search is a secondary
index, the upload must not fail because of it).

### 5.3 The worker

A singleton loop inside the app process (registered from `instrumentation.ts`, guarded
by a `globalThis` handle exactly like the Prisma client so dev hot-reload doesn't fork
it). No cron, no child process.

```
loop:
  reclaim: running jobs with leaseExpiresAt < now → back to queued   (crash recovery)
  job = first queued with nextAttemptAt <= now, ORDER BY priority, createdAt
        WHERE model ∈ {activeModel, targetModel}      (orphans of cancelled
                                                       migrations are skipped/purged)
  if none → sleep POLL_MS (default 15 s; an enqueue also pings the loop to wake early)
  mark running, leaseExpiresAt = now + 5 min
  cfg = model config the JOB names (active or target — from EmbeddingSettings)
  build input (§5.1); if its sourceSha256 already matches the stored Embedding row
    → mark done WITHOUT a provider call (makes re-queues after benign races free)
  provider call (~10 s) → verify dim → normalize
  upsert Embedding row for (kind, targetId, job.model)
  (+ write ExtractionLog kind="embedding", §9)
  mark done; bump the in-memory index version (§6.3) if job.model == activeModel;
  if a migration is indexing and this was its last missing item → migrationState="ready"
on error:
  attempts++; lastError = message
  attempts < 8 → status queued, nextAttemptAt = now + min(30 s × 2^attempts, 1 h)
  else       → status failed  (surfaces in the admin panel, §10; manual retry re-queues)
```

**Concurrency 1.** Each call holds the (self-hosted, likely single-GPU) endpoint for
10 s; parallel calls would just queue server-side. Make it a config
(`EMBEDDING_CONCURRENCY`, default 1) for a beefier endpoint later. Terminal races are
benign: if a receipt is deleted mid-embed, the final upsert notices the target is gone
and drops the result.

### 5.4 Backfill / reconcile sweep

On worker start (and once a day thereafter) a sweep enqueues, at **priority 1**, every
receipt and every claim — including drafts whose `updatedAt` is ≥ 10 min old — that
either has no `Embedding` row for the active model or whose `sourceSha256` no longer
matches (covers: pre-feature rows, rows that missed a trigger, edits that raced;
recently-touched drafts are skipped because their debounced job already exists). While a migration is in flight the sweep does the same for
the **target** model — the sweep IS the migration's re-index engine, no separate code
path. It also purges `Embedding`/job rows whose model is neither active nor target
(leftovers of a cancelled migration interrupted mid-cleanup). The sweep is a single
indexed query pair + upserts; idempotent and cheap. At 10 s per item a 1,000-receipt
history backfills in ~3 h of quiet background work while new uploads still jump the
line at priority 0.

## 6. Query path (the 500 ms path)

### 6.1 API

```
POST /api/search        { query: string (1..300),
                          types?: ("receipt"|"claim")[]   default both,
                          scope?: "mine" | "all",         default "mine"
                          decidedByMe?: boolean }         approver filter
→ 200 {
    groups: [{ year: 2026, items: [
      { kind: "receipt", id, score, merchant, purchaseDate, note, originalName,
        ownerName?,             // only present when scope="all"
        claims: [{id, status}] },
      { kind: "claim", id, score, status, totalCents, claimDescription,
        ministries: string[], ownerName?, createdAt } ] }],
    indexed: { receipts: n, claims: n, pending: n }   // honesty footer, §7.3
  }
```

Standard shape: `handleApi` + `requireUserId`, zod body, POST (queries in bodies, not
URLs — they contain user content and shouldn't land in access logs).

Flow:

1. Resolve caller's role from the verified `User.role` mirror. `scope:"all"` or
   `decidedByMe` from a plain member → **404** (indistinguishable from not-found,
   per invariant 2).
2. Embed `queryPrefix + query` **with the active model** — the ~500 ms provider call —
   through a small **server-side LRU** keyed on `(model, queryPrefix, normalized
   query)` (~200 entries, 15 min TTL): repeated searches, back-navigation, and filter
   tweaks skip the wait entirely; a model cutover implicitly invalidates the cache by
   key. Filter changes never re-embed (the vector doesn't depend on filters).
3. Score against the in-memory index (§6.3) **after** applying the permission scope
   (§6.2) and filters — tenant scoping is a pre-filter, never a post-filter.
4. Keep the global top **50** with score ≥ **0.25** (threshold behind a config,
   `EMBEDDING_MIN_SCORE`, to tune against the real model), group by `year` descending,
   items within a year by score descending.
5. Hydrate display fields for the survivors only (one `findMany` per kind).

### 6.2 Permission matrix (who sees what)

| Caller (verified role mirror) | scope="mine" | scope="all" | decidedByMe |
| :-- | :-- | :-- | :-- |
| member | own receipts + own claims | 404 | 404 |
| approver | own | all receipts + all claims | claims where `approverUserId = me` AND status ∈ approved/rejected/paid (their decided set; receipts attached to those claims ride along) |
| treasurer / admin | own | all receipts + all claims | same as approver (a treasurer can also hold assignments) |

"All claims" includes **drafts** — consistent with the ratified principle below (role
holders may read all reimbursements); the result card shows the `draft` status pill so
a searcher knows they are looking at work in progress.

Duty pauses (`approvalsPaused`/`financePaused`) do **not** narrow search: pauses are
workflow routing, not access revocation (same posture as keeping already-assigned
claims decidable). Role loss does narrow it — the mirror is re-read on every request.

**This is a new cross-tenant read grant — ratified.** The operator's position: approvers
and treasurers should have read access across all reimbursements anyway; search is
simply the first surface built on that principle. ESIGN_DESIGN §6.3 currently
enumerates approver-inbox / finance-queue / packet / certificate / reconcile /
`/v/<token>` as the only non-owner reads. Shipping this feature amends that list with:

> *Role read (ratified): holders of a verified approver/treasurer/admin role may read
> receipts and claims across all tenants — search summaries and receipt files today;
> future role-facing read surfaces may rely on the same grant. Draft claims are
> included. Writes remain owner-only (plus the existing ceremony paths).*

Consequences that must land in the same PR:
- `GET /api/receipts/[id]/file` (and `/preview`) gain the same role gate beside the
  owner check (an approver clicking a foreign receipt result must see the image;
  today that's an owner-only 404). Claim results deep-link to the existing granted
  surfaces (inbox/finance detail) when one applies, else show the summary card only.
- `tests/e2e/security.spec.ts`'s cross-tenant-404 sweep gets the deliberate exception,
  exactly as the §6.3 grants did.
- It stays **role-gated by the verified mirror** — never by `ADMIN_EMAILS` (which is
  app-surface bootstrap, not a data-access grant).

### 6.3 Scoring engine

`src/lib/embeddings/index-cache.ts`: a module-level (globalThis-guarded) cache of the
**active-model** `Embedding` rows decoded into one `Float32Array` matrix + a parallel
metadata array `{kind, targetId, userId, year}`. Invalidation is a version counter
bumped by the worker/delete/cutover paths; the search path reloads lazily when the
version moved. Vectors are unit-length (§3.1), so scoring one query is a dot product
per row — at 5,000 items × 1,024 dims that's ~5 M multiply-adds, well under a
millisecond; memory ~20 MB. (If a deployment ever outgrows this, the escape hatch is
swapping this one module for sqlite-vec — nothing else changes.)

### 6.4 Year grouping

The year is **denormalized onto the Embedding row at write time** (`year` column) so
grouping needs no joins:

- **Receipt**: `purchaseDate` prefix (`YYYY` of the transcription string) when it looks
  like a date; else `createdAt` year. This is a substring read of a transcription for
  display bucketing — not date arithmetic (invariant respected).
- **Claim**: `submittedAt ?? createdAt` year (drafts have no `submittedAt`, so they
  bucket by creation year and move buckets at submission if the years differ — the
  re-embed at freeze recomputes it).

Ingest recomputes it on every (re-)embed; a re-extraction that changes `purchaseDate`
also re-triggers via the image-edit path or is corrected by the daily sweep.

## 7. UI design

### 7.1 Placement

A dedicated **`/search`** page plus a search entry in the NavBar (magnifier button;
`Cmd/Ctrl-K` shortcut). Server component does the usual `currentUserId()` redirect and
passes the caller's role capabilities (may use scope-all? may use decidedByMe?) so the
client renders only the filters this user is allowed to touch. The nav entry renders
only when the feature is configured and enabled (`EmbeddingSettings.enabled`).

### 7.2 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  🔍 [ Search receipts and claims…               ]  [Search]  │
│                                                              │
│  [All types ▾]  [Everyone ▾]        [☑ Decided by me]        │  ← filter row
│   receipts/claims  mine/everyone      approver+ only         │
│                                                              │
│  2026 ─────────────────────────────────────────────────────  │
│  ┌─────────┐  Costco  ·  05/12/2026  ·  $214.80              │
│  │ thumb   │  "folding chairs for retreat" · on claim #…     │
│  └─────────┘                                        ● 0.81   │
│  ┌─────────┐  CLAIM · approved · $412.55 · by Grace L.       │
│  │ 📄       │  "Youth retreat supplies" · 210 Youth           │
│  └─────────┘                                        ● 0.74   │
│                                                              │
│  2025 ─────────────────────────────────────────────────────  │
│  …                                                           │
└──────────────────────────────────────────────────────────────┘
```

- **Year headers** are sticky section headers; groups render newest year first.
- **Receipt cards**: thumbnail (`/file`, or `/preview?page=1` for PDFs — the same
  sources ReceiptGrid uses), merchant, date, note, owner (scope=all only), chips
  linking to the claims it sits on. Click → ReceiptViewer.
- **Claim cards**: status pill (existing `Common.status.*` labels), total
  (`formatCents`), claimDescription, ministry chips, owner. Click → the surface the
  viewer is entitled to (own claim → review screen; assigned approver → inbox detail;
  treasurer → finance detail; otherwise the card is informational).
- A relevance dot/bar visualizes `score`; exact numbers stay in a tooltip (scores are
  meaningful ordinally, not absolutely).

### 7.3 Designing around the 500 ms query embed

The latency budget (~500 ms embed + ~10 ms scoring + hydration) lands at ~600–700 ms —
too slow for search-as-you-type, comfortably fast for explicit search. So:

- **Explicit submit** (Enter or button). No per-keystroke requests, no debounce tricks —
  also keeps query-embed load and `ExtractionLog` volume proportional to real searches.
- **Instant acknowledgment**: on submit the input shows an inline spinner and the
  button goes disabled ("Searching…"); the previous results stay visible but dimmed
  (opacity + non-interactive) rather than being ripped out — no layout jump for what is
  usually a sub-second wait. First-ever search shows 3 skeleton cards instead.
- **Stale-response guard**: each submit carries a monotonic id; only the latest
  response renders. In-flight fetches are cancelled via `AbortController` when a new
  submit or a filter change lands.
- **Filter changes re-query without re-embedding** (server LRU hit → ~50 ms), so
  toggling "Decided by me" or a type chip feels instant even though it round-trips.
- **No artificial optimism**: if the call exceeds ~3 s (endpoint cold start), the
  spinner gains a "Still searching…" line; on error the standard translated error
  banner appears with the previous results restored to full opacity.
- **Honesty footer** while the backfill is incomplete:
  "Some items aren't searchable yet — n receipts and m claims are still being indexed."
  (from the `indexed.pending` count). This turns "why can't I find it" confusion during
  the first hours of rollout into an expected state.
- Empty state distinguishes "no matches" from "nothing indexed yet".

### 7.4 i18n & testids

Every string through `messages/<locale>.json` with translator `context` notes
(the short ones especially: "Decided by me", "Everyone", "Searching…", relevance
tooltip). New testids, following the existing convention:
`search-input, search-submit, search-type-filter, search-scope-filter,
search-decided-filter, search-group-<year>, search-result-<kind>-<id>,
search-pending-note, search-empty` — plus the admin card's
`embedding-settings-form, embedding-test-connection, embedding-save,
embedding-migration-progress, embedding-cutover, embedding-cancel-migration,
embedding-retry-job-<id>`.

## 8. Failure modes

| Failure | Behavior |
| :-- | :-- |
| Endpoint down during search | 502 with code `search.embedUnavailable` (translated client-side); results panel keeps prior state |
| Endpoint down during ingest | jobs retry with backoff (§5.3); queue depth visible in admin; search keeps serving the existing index |
| Job fails 8 times | `status="failed"`, listed in admin with `lastError`; "Retry" re-queues; a later daily sweep also re-queues it (sha mismatch persists) |
| Admin enters a bad endpoint/model/dim | the save-time probe (§3.2) rejects it — misconfiguration cannot reach the worker or the index |
| Endpoint reconfigured out-of-band (dim drift) | provider's dim check errors the job (visible in admin); active index unaffected until vectors actually change |
| New model is worse than the old one | discovered before cutover via the admin preview-search box (§3.3); cancel the migration, nothing was lost |
| Container crash mid-embed / mid-migration | lease expiry reclaims `running` rows; migration state is all in SQLite, so it resumes where it left off |
| Feature unconfigured | no nav entry, `/search` and `/api/search` 404, worker never starts — zero footprint |

## 9. Telemetry (invariant 7)

Every embedding provider call — document ingest **and** query, success **and**
failure — writes an `ExtractionLog` with `kind="embedding"`:
`prompt` = the composite text / query text (images referenced by metadata only, as with
`kind="receipt"` — never bytes), `model` = the model the call actually used (active or
target; `"mock"` under EMBEDDING_MOCK), `parsedJson` = `{dim, targetKind?, targetId?}` —
**never the vector** (it's opaque bulk, and rawResponse stays null for the same
reason), `durationMs`, `status`/`errorMessage`. Queue mutations themselves are not
AuditEvents (no human action, no claim content change); admin actions **are**:
`update-embedding-config` (field diff, API key redacted, §3.2), `retry-embedding`,
`embedding-cutover`, `embedding-migration-cancel`.

## 10. Admin surface

A "Search index" card on `/admin` behind the existing `isAppAdmin()` gate
(API under `/api/admin/…`):

- **Backend settings** (§3.2): endpoint, API key (write-only field, shows fingerprint),
  model, dim, query prefix, enabled toggle; "Test connection" runs the probe.
- **Queue health**: counts by job status, oldest queued age, failed-job list with
  `lastError` + per-row and bulk Retry.
- **Migration panel** (visible while `migrationState ≠ none`): progress bar
  (n/m target-model rows present), preview-search box against the target model,
  **Cut over** (enabled when `ready`, or the auto-cutover checkbox), **Cancel**.
- **Rebuild index**: re-embeds everything on the current model (sha-mismatch sweep with
  forced staleness) — the hammer for "the endpoint was silently swapped under me".

## 11. Testing plan

- **Unit** (Vitest, `EMBEDDING_MOCK`): cosine/top-K/threshold/year-grouping pure
  functions; queue state machine (enqueue-dedupe, backoff schedule, lease reclaim,
  failed-terminal, **draft debounce** — successive mutations push `nextAttemptAt`,
  the job runs only after quiet, an edit racing a running job re-queues it and the
  hash short-circuit makes the follow-up a no-op); claim composite builder (money
  formatting, CJK content untouched, excluded rows omitted, draft vs frozen);
  permission matrix as a table test — member/approver/treasurer × scope × filter,
  asserting 404s exactly where the matrix says; **migration lifecycle** — start →
  dual-model enqueue on live triggers → coverage → ready → cutover flips the index
  and purges old rows; cancel purges target rows; settings probe rejects a dim
  mismatch (mock models are deliberately incompatible, §3.1, so these tests are real).
- **e2e** (chromium, mock embeddings, `EMBEDDING_DRAFT_IDLE_MS` shrunk to ~1 s):
  upload → worker indexes → search finds it; a draft claim becomes searchable after
  the idle window and an edit refreshes its embedding; approver searches another
  member's receipt and can open the image; member with
  `scope:"all"` gets 404; "Decided by me" returns only decided claims; admin changes
  the model → search still works mid-migration → cutover → search works on the new
  model; security sweep updated for the new deliberate grant.
- **Mock design note**: the mock must be similarity-meaningful (bag-of-tokens folded
  into the space), not random — e2e asserts *ranking*, not just presence.

## 12. Open questions (blocked on the endpoint contract)

1. **Confirm OpenAI-compatibility details**: exact image-input encoding for
   `/v1/embeddings` (data-URI content part vs. a custom field), auth header, and
   whether text+image can be embedded as ONE input (affects §5.1 pairing) — or images
   and text land in a shared space via separate calls (Qwen3-VL-style unified space
   assumed).
2. **Dimension & truncation**: native dim? MRL-truncatable (store 1024 instead of 4096
   → 4× smaller matrix)? If truncation is chosen, it's part of the model config and a
   change to it is just another §3.3 migration.
3. **Batching**: can the endpoint take a batch? (Worker stays sequential either way,
   but backfill could batch 4–8 images per call if supported.)
4. **Instruction prefixes**: Qwen embedding models score better with an instruction on
   the *query* side — confirm and set the exact string in `queryPrefix` (§3.2; admin-
   editable, no re-index needed to tune it).

## 13. Build order

1. Schema + migration (3 tables); provider (OpenAI-compatible default) + mock;
   settings accessor with env seed + probe; ingest module with composite builder.
2. Worker + triggers + backfill/reconcile sweep (gated on settings existing+enabled).
3. `/api/search` + index cache + permission matrix (+ file/preview role gate + §6.3
   amendment + security-sweep update in the same PR).
4. `/search` UI + NavBar entry + i18n catalogs.
5. Admin card: settings + queue health, then the migration panel + cutover.
6. Docs graduation: new invariants into `CLAUDE.md` / `DATA_MODEL.md`.
