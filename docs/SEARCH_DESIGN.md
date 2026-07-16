# Semantic search across receipts and claims — design

Status: **proposed (rev 2 — post critique round 1); endpoint contract verified live**
(§3.1, 2026-07-16 — re-check anytime with `scripts/probe-embedding-endpoint.mjs`).
Companion to `docs/ESIGN_DESIGN.md` (this feature amends its §6.3 read-grant list) and
`docs/agent/DATA_MODEL.md` (three new tables).

## 1. Goal

Let users find receipts and claims by meaning, not exact text: "the projector we bought
for VBS", "that Costco run with the returned chairs", "王姐妹's retreat snacks" — and
*also* by the exact fragments people actually remember ("$214.80", "Costco"), via a
cheap exact-match pass that runs beside the semantic one (§6.2).

- **Members** search their own receipts and their own claims. Results are levers, not
  dead ends: an unclaimed receipt offers "start a claim", a claimed one leads to its
  claim and status.
- **Approvers** search **all** receipts and **all** claims (default scope — their
  canonical lookup is someone else's claim), with a filter for claims they decided.
- **Treasurers** (and admins) likewise search everything by default.
- Ranked by cosine similarity of a Qwen multimodal embedding; presented **grouped by
  year** with the single best match pinned on top (§7.2) so grouping never buries it.
- **All claims are indexed, drafts included**: a draft becomes searchable once left
  unchanged for **10 minutes** (a debounce — active editing never burns 15 s embeds
  per keystroke, §5.2); frozen claims index immediately.
- The embedding backend (endpoint, model, dimension) is **operator-changeable from the
  admin interface at runtime**, with a shadow re-index so search never goes dark (§3.3).

Two latency constraints drive the architecture:

| Operation | Latency (measured, §3.1) | Consequence |
| :-- | :-- | :-- |
| Embed a search query (text) | ~150–700 ms (design budget 500 ms) | Query embedding happens synchronously per search; the UI is designed around an explicit-submit, sub-second search — never per-keystroke |
| Embed a receipt image / claim composite | ~15 s at 640 px (~90 s undownscaled — hence `EMBEDDING_MAX_PX`) | Document embedding is NEVER done in a request path. A durable SQLite-backed job queue with retry embeds items in the background as they appear, plus a backfill sweep for pre-existing items |

## 2. Non-goals

- No external services. The queue is a SQLite table worked by the existing single Node
  process — same "no queue, no cache, no other services" posture as the rest of the app.
- No vector database / SQLite extension. At church scale (thousands of receipts,
  hundreds of claims) brute-force cosine over an in-memory Float32 matrix is
  sub-millisecond; sqlite-vec et al. are complexity we don't need. Revisit only if
  corpus size × dim makes the resident matrix a memory problem (see §6.4).
- No search *engine* (FTS5, ranking DSLs). The exact-match pass (§6.2) is one indexed
  `LIKE`/equality query, not an inverted index.
- No instant indexing of in-flight drafts: a draft under active edit is only
  re-embedded after 10 idle minutes (§5.2) — mid-edit staleness up to that window is
  accepted and surfaced (§7.4).

## 3. Embedding backend

### 3.1 Provider contract — VERIFIED against the real endpoint

The endpoint (`https://apollo.vrwarp.com`, llama.cpp serving `qwen3-vl-embedding-2b`)
was probed on 2026-07-16; `scripts/probe-embedding-endpoint.mjs` re-runs the full check
suite anytime (`EMBEDDING_ENDPOINT=… EMBEDDING_API_KEY=… node scripts/…`). Verified:

- **Vectors**: dim **2048**, already unit-normalized, deterministic. Text and image
  vectors live in ONE space (native-route text ≡ `/v1` text, cos 1.0000), and
  cross-modal ranking is real: "coffee at Starbucks" → coffee-receipt image 0.67 vs
  hardware-receipt image 0.34 (and symmetrically for a hardware query).
- **Queries — `POST /v1/embeddings`** (OpenAI-compatible): `{model, input}` where
  input is a string **or array of strings** (batch works). Text only — images cannot
  go through this route (a data-URI is tokenized as text). The `model` field is
  accepted but ignored (single-model llama.cpp server). ~150–700 ms per call.
- **Documents — `POST /embeddings`** (native): `{content: [{prompt_string,
  multimodal_data: [rawBase64, …]}]}`, one `<__media__>` token in `prompt_string` per
  image. **Raw base64 only** — a data-URI prefix fails. **Text+image pairing works**
  (prose around the `<__media__>` token) and batch = multiple `content` items (one
  vector each, identical to singles).
- **Formats**: PNG, JPEG, GIF accepted. **WebP is REJECTED** ("Failed to load image")
  — critical, because the app stores receipts as WebP. **PDF bytes are rejected** too.
  Ingest therefore always sends JPEG: WebP → JPEG transcode via sharp (embedding
  fidelity of the transcode: cos 0.9995), PDF → page-1 raster → JPEG.
- **Image size drives latency hard**: ~15 s at 480×640, **~90 s at 1200×1600** (the
  app's stored-image cap). Ingest embeds a **downscaled copy (≤640 px long side,
  `EMBEDDING_MAX_PX`)** — a 480×640 embed agrees with the 1200×1600 one at cos 0.982,
  so we pay 15 s instead of 90 for essentially the same vector. Budget ~15 s/item.
- **Server context is 8192 tokens** — bounds the claim text composite (§5.1). Token
  counting is not available client-side, so the composite uses a conservative byte
  budget (~4 000 UTF-8 bytes ≈ well under 4 k tokens even for CJK-heavy text, leaving
  room for the ~1–2 k patch tokens of a paired 640 px image); if the endpoint still
  returns `exceed_context_size_error`, the worker halves the items list and retries
  once before counting the attempt as a failure.
- The instruction prefix (`"Instruct: Retrieve the receipt matching the query.
  Query: "`) is confirmed working on the query side; documents embed without a prefix.

The integration stays isolated behind one module:

```
src/lib/embeddings/provider.ts     embedText(text, cfg) / embedImage(bytes, mime, text?, cfg)
                                   → Float32Array(cfg.dim), L2-normalized.
                                   embedText → /v1/embeddings; embedImage → native
                                   /embeddings, after normalizing the input to a
                                   ≤EMBEDDING_MAX_PX JPEG via sharp (WebP/PNG/
                                   oversized → transcode+downscale, §3.1).
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
  migrationState String   @default("none") // none | indexing  (cutover is automatic)
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
| `EMBEDDING_ENDPOINT` | base URL (serves both `/v1/embeddings` and native `/embeddings`); feature is OFF until some config exists (no nav entry, routes 404, worker idle) |
| `EMBEDDING_API_KEY` | bearer token |
| `EMBEDDING_MODEL` | model id string, stored on every vector row (`qwen3-vl-embedding-2b`; llama.cpp ignores the request field, but it is our row-identity key) |
| `EMBEDDING_DIM` | vector dimension (2048 for qwen3-vl-embedding-2b) |
| `EMBEDDING_QUERY_PREFIX` | instruction prefix for query embeds — confirmed effective: `"Instruct: Retrieve the receipt matching the query. Query: "` |
| `EMBEDDING_MAX_PX` | default 640 — long-side cap for image inputs (§3.1: 15 s vs 90 s per embed, cos 0.982 agreement) |
| `EMBEDDING_TIMEOUT_MS` | default 120000 — a 15 s embed with queueing ahead of it needs headroom (not in DB — plumbing, not policy) |
| `EMBEDDING_DRAFT_IDLE_MS` | default 600000 — the 10 min draft-idle debounce (§5.2); tests shrink it |
| `EMBEDDING_MOCK=1` | deterministic vectors, no network |

**Probe policy (no admin lockout).** The live probe (embed a fixed test string, check
HTTP success + vector length == dim; **10 s timeout**, independent of
`EMBEDDING_TIMEOUT_MS`) runs only when a save would make the worker/search *do more*:
enabling the feature, or changing endpoint/model/dim while enabled. It never gates
turning `enabled` off, cancelling a migration, or editing `queryPrefix`. An explicit
"Save without testing" toggle (audited as such) covers the endpoint-is-down-and-I-
know-it case, so a dead endpoint can never lock the admin out of their own config.
A "Test connection" button runs the same probe standalone. Every settings change
writes an `AuditEvent` (`action="update-embedding-config"`, detail = field diff with
the API key redacted to a fingerprint).

### 3.3 Changing the model — the migration lifecycle

A model change is never a hot swap: query vectors are only comparable to document
vectors from the **same model**, so flipping the model string would make the whole
index unscoreable until a multi-hour re-embed finished. Changing **model or dim**
starts a **shadow re-index with automatic cutover**; search keeps serving the old
model until the new index is complete:

```
none ──(admin saves new model/dim; probe passes)──▶ indexing ──(coverage 100%)──▶
 ▲                                                     │      auto-cutover (txn):
 └──(admin cancels: target rows/jobs deleted)◀─────────┘      active←target, delete
                                                              old-model rows+jobs,
                                                              state→none, bump index
```

- **Edit classification** (per-field, so routine operations don't trigger re-indexes):
  API key or endpoint URL alone → probe (if enabling/enabled) and apply in place — a
  credential rotation or a host move serving the *same model* keeps every vector
  valid. Model or dim → shadow migration. `queryPrefix`/`enabled` → apply in place.
- **While `indexing`**: live triggers (§5.2) enqueue **both** models so items created
  mid-migration have no coverage hole; the sweep (§5.4) drives the target re-index;
  queries and scoring use `active*` exclusively — search quality is untouched. Further
  backend edits are **rejected until the migration is cancelled** (one migration at a
  time; prevents same-model-name/different-endpoint aliasing, since job identity is
  the model string).
- **Auto-cutover** fires when the sweep finds no missing/stale target rows: one
  transaction flips `active* ← target*`, clears `target*`, deletes old-model
  `Embedding`+`EmbeddingJob` rows, sets state `none`; then bumps the index-cache
  version. If the process crashes mid-cutover the transaction never happened —
  the next sweep simply cuts over again. The admin card shows progress (n/m) while
  indexing; no manual cutover step to forget. **Cancel** deletes target rows/jobs and
  clears `target*`.
- Rollback after cutover = run a migration back to the old settings (symmetric; old
  vectors were deleted — keeping them would double storage for a rare event).
- The query LRU keys on `(model, queryPrefix, query)` (§6.1), so a cutover implicitly
  invalidates cached query vectors.

Non-obvious invariant this buys: **`Embedding.model` (and the job's `model`) is part
of row identity** — uniqueness is `(kind, targetId, model)`, the search index loads
only `activeModel` rows, and the worker embeds with whatever model the *job* names.
All migration behavior falls out of those three rules.

## 4. Data model

Three new tables (append to `prisma/schema.prisma`; migration committed as usual):
`EmbeddingSettings` (§3.2), plus the vector store and the queue below. Vectors live in
their own table, not columns on Receipt/Reimbursement, so a model change is row churn
rather than schema surgery, and so the join-free scan the search path does (§6.4)
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
  year         Int      // grouping key (see §6.5 for how it is derived)
  model        String   // which backend produced the vector — part of row identity
  dim          Int
  vector       Bytes    // Float32Array little-endian, L2-normalized, length == dim
  // Fingerprint of the FULL embedding input (not just the image): staleness is
  // detected by rebuilding this and comparing.
  //   receipt: sha256(imageFileSha256 ‖ note ‖ merchant ‖ purchaseDate)
  //   claim:   sha256(composite text)                       (§5.1)
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
  // Bumped by every enqueue-upsert. The worker records it when claiming and its
  // terminal write is conditional on it (§5.3) — an enqueue racing a running
  // embed can therefore never be lost.
  generation    Int       @default(0)
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

Sizing (fix from review): 2048 dims × 4 bytes = **8 KB/vector**; 5 000 items ≈ 40 MB
in SQLite and ~40 MB resident in the index cache (~80 MB briefly during a migration).
Fine for the single-container deployment; revisit only past ~20 k items.

Deletion: the receipt DELETE route and claim DELETE route also delete the matching
`Embedding` + `EmbeddingJob` rows — all models' rows (no FK cascade — do it in the
route transaction).

**SQLite concurrency**: the worker is a persistent second writer beside request
handlers, so the app sets `journal_mode=WAL` and `busy_timeout=5000` at startup
(worker registration runs the pragmas; they persist on the database file). The worker
NEVER holds a transaction across the ~15 s provider call — claim job (short write) →
embed (no txn) → finalize (short write).

## 5. Ingest pipeline (the 15 s path)

### 5.1 What gets embedded

**Receipts — the stored image + its text metadata.** Input to `embedImage()` is the
already-compressed stored file (`filePath`, ~100 KB WebP — never the original), which
the provider normalizes to a **≤640 px JPEG**: the endpoint rejects WebP outright and
an undownscaled image costs ~90 s instead of ~15 s for a near-identical vector (§3.1).
The user's `note` + extracted `merchant` ride in `prompt_string` ahead of the
`<__media__>` token — which is why they are part of the staleness fingerprint (§4).
PDF receipts embed their **page-1 raster**, reusing the existing preview machinery
(`src/lib/pdf/preview.ts` cache; generate on demand if not yet cached) — those cached
pages are WebP too, so they pass through the same JPEG normalization.

**Claims — a text composite of the claim's content + first receipt image.**
The naïve reading of "embed the claim PDF" — rasterize the form page — would be a
mistake: every form page is 90% identical AcroForm boilerplate, so all claims would
cluster together and similarity would be dominated by the template, not the content.
Instead the claim's embedding input is a **structured text composite** of the claim's
content (for a frozen claim, exactly what the packet contains), paired with the first
receipt image:

```
Reimbursement claim by <fullName>. <claimDescription>.
Ministries: <distinct formatMinistryEvent values>.
Items: <description> ($<amount>); <description> ($<amount>); …
Merchants: <distinct receipt merchants>. Total $<total>. <MM/YYYY>.
```

(Amounts formatted at this boundary via `src/lib/money.ts`, like the LLM boundary.)
The composite is capped at a conservative **~4 000 UTF-8 bytes** (§3.1 context math):
the items list truncates with an "… and N more items" tail — a 60-row claim's gist
survives; verbatim completeness is not the goal. `sourceSha256` for a claim is the
**sha256 of the composite text itself** — the fingerprint of exactly what was
embedded, uniform across drafts and frozen claims; staleness checks are "rebuild,
compare". Excluded rows are left out of the composite, so excluding/restoring is a
content change like any other.

### 5.2 Triggers (event-driven — items embed "as soon as available")

| Event | Action |
| :-- | :-- |
| Receipt uploaded (`POST /api/receipts`) | enqueue `{kind:"receipt"}`, priority 0 |
| Receipt image edited / restored (`/api/receipts/[id]/edit`) | re-enqueue (image sha changed) |
| Receipt note edited (`PATCH /api/receipts/[id]`) | re-enqueue (note is embedded text, §5.1) |
| Receipt extraction (re)stamped — claim create, add-receipts, manual-entry PATCH | re-enqueue the **receipt** (merchant/purchaseDate are embedded text + the year key) |
| Any draft-claim content mutation (claim created, claim PATCH, line-item PATCH/split/merge, receipts added/removed, manual entry) | enqueue `{kind:"claim"}`, priority 0, **`nextAttemptAt = now + 10 min`** — the draft-idle debounce, see below |
| Claim PDF generated (`POST …/pdf`) | re-enqueue `{kind:"claim"}` with `nextAttemptAt = now` (content is frozen; index immediately); regeneration likewise |
| Claim submitted (e-sign) | re-enqueue claim (status/year may shift: `submittedAt` becomes the year key) |
| Claim reverted to draft | re-enqueue with the draft debounce (stays searchable; refreshes if post-revert edits change content) |
| Receipt / claim deleted | delete `Embedding` + job rows (all models) |

Every enqueue targets the **active** model — and additionally the **target** model
while a migration is `indexing` (§3.3), so cutover has no coverage holes.

**The draft-idle debounce costs no new machinery** — it is the queue's own upsert
semantics: every draft mutation re-upserts the job with `nextAttemptAt = now + 10 min`
and `generation++`, so continuous editing keeps pushing the embed into the future, and
the job only becomes runnable once the draft has sat untouched for 10 minutes. The
worker embeds whatever the claim contains *at run time* (never a snapshot from enqueue
time), and the generation check below makes an enqueue racing a running embed
impossible to lose. The window is `EMBEDDING_DRAFT_IDLE_MS` (default 600000).
All draft mutation paths already write the claim row (`totalCents` recompute /
`updatedAt`), so the trigger list above is exactly the routes that must call
`enqueueClaimEmbedding()` — a new mutation route joining invariant-7's telemetry duty
also joins this one.

"Enqueue" = upsert on `(kind, targetId, model)`: `status="queued"`, `attempts=0`,
`generation++`, `nextAttemptAt` as the trigger dictates, keep/raise priority. Never
blocks or fails the calling route — queue write errors are logged and swallowed
(search is a secondary index; the upload must not fail because of it).

### 5.3 The worker

A singleton loop inside the app process, started from `instrumentation.ts` (which the
repo does not have yet — new file). Registration is guarded three ways:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;           // never on edge
  if (process.env.NEXT_PHASE === "phase-production-build") return; // never at build
  const g = globalThis as { __embedWorker?: { stop(): void } };
  g.__embedWorker?.stop();                // dev hot-reload: replace, don't duplicate
  g.__embedWorker = startEmbeddingWorker(); // no-op loop until settings exist+enabled
}
```

(The stop-and-replace handle means edits to worker code take effect on dev reload
instead of a stale closure surviving forever.) The loop:

```
loop:
  reclaim: running jobs with leaseExpiresAt < now → status=queued, nextAttemptAt=now
  job = first queued with nextAttemptAt <= now, ORDER BY priority, createdAt
        WHERE model ∈ {activeModel, targetModel}      (orphans of cancelled
                                                       migrations are skipped/purged)
  if none → sleep POLL_MS (default 15 s; an enqueue also pings the loop to wake early)
  claim: mark running, leaseExpiresAt = now + 5 min, remember gen = job.generation
  cfg = model config the JOB names (active or target — from EmbeddingSettings)
  build input (§5.1); if its sourceSha256 already matches the stored Embedding row
    → finalize as done WITHOUT a provider call (benign-race re-embeds are free)
  provider call (~15 s, NO db transaction held) → verify dim → normalize
  finalize (single short transaction):
    upsert Embedding row for (kind, targetId, job.model)
    updateMany job → done WHERE id AND status="running" AND generation = gen
      → 0 rows affected = an enqueue raced us (job is queued again with gen+1):
        leave the queue row alone — the follow-up run re-embeds, and the hash
        short-circuit makes it free if content settled back
  write ExtractionLog kind="embedding" (§9); bump index version if model == active;
  if migration indexing and target coverage now complete → run auto-cutover (§3.3)
on error:
  attempts++; lastError = message
  attempts < 8 → status queued, nextAttemptAt = now + min(30 s × 2^attempts, 1 h)
  else       → status failed  (surfaces in the admin panel, §10; manual retry re-queues)
```

**Concurrency 1.** Each call holds the (self-hosted, single-GPU llama.cpp) endpoint
for ~15 s; parallel calls would just queue server-side. Make it a config
(`EMBEDDING_CONCURRENCY`, default 1) for a beefier endpoint later. Terminal races are
benign: if a receipt is deleted mid-embed, the finalize upsert notices the target is
gone and drops the result.

### 5.4 Backfill / reconcile sweep

On worker start (and once a day thereafter) a sweep enqueues, at **priority 1**, every
receipt and every claim — including drafts whose `updatedAt` is ≥ 10 min old — that
either has no `Embedding` row for the active model or whose freshly-rebuilt
`sourceSha256` no longer matches (covers: pre-feature rows, rows that missed a
trigger, edits that raced; recently-touched drafts are skipped because their debounced
job already exists). While a migration is in flight the sweep does the same for the
**target** model — the sweep IS the migration's re-index engine, no separate code
path. It also purges `Embedding`/job rows whose model is neither active nor target
(leftovers of a cancelled migration interrupted mid-cleanup). The sweep is a single
indexed query pair + upserts; idempotent and cheap. At ~15 s per item a 1,000-receipt
history backfills in ~4 h of quiet background work while new uploads still jump the
line at priority 0.

## 6. Query path (the 500 ms path)

### 6.1 API

```
POST /api/search        { query: string (1..300),
                          types?: ("receipt"|"claim")[]   default both,
                          scope?: "mine" | "all",         default: "all" for verified
                                                          approver/treasurer/admin,
                                                          "mine" for members
                          decidedByMe?: boolean }         role-holder filter
→ 200 {
    exact:  [ …same item shapes as below… ],   // §6.2 exact-match pass, ranked first
    best:   { …item… } | null,                 // global top semantic hit (pinned)
    groups: [{ year: 2026, items: [
      { kind: "receipt", id, score, merchant, purchaseDate, note, originalName,
        ownerName?,                     // scope="all" only
        claims: [{id, status}] },       // empty array = "Not on a claim" (§7.3)
      { kind: "claim", id, score, status, totalCents, claimDescription,
        ministries: string[], ownerName?, createdAt } ] }],
    indexed: { pending: n, myPendingReceipts: n, myPendingClaims: n },  // §7.4
    degraded?: "semanticUnavailable"           // §6.2 fallback marker
  }
```

Standard shape: `handleApi` + `requireUserId`, zod body, POST (queries in bodies, not
URLs — they contain user content and shouldn't land in access logs).

Flow:

1. Resolve caller's role from the verified `User.role` mirror. `scope:"all"` or
   `decidedByMe` from a plain member → **404** (indistinguishable from not-found,
   per invariant 2).
2. Run the **exact-match pass** (§6.2) — pure SQL, no provider dependency.
3. Embed `queryPrefix + query` **with the active model** — the ~500 ms provider call —
   through a small **server-side LRU** keyed on `(model, queryPrefix, normalized
   query)` (~200 entries, 15 min TTL): repeated searches, back-navigation, and filter
   tweaks skip the wait entirely. Filter changes never re-embed (the vector doesn't
   depend on filters). If this call fails, return exact results with
   `degraded:"semanticUnavailable"` instead of 502ing the whole search (§7.4).
4. Score against the in-memory index (§6.4) **after** applying the permission scope
   (§6.3) and filters — tenant scoping is a pre-filter, never a post-filter.
5. Keep the global top **50** with score ≥ **0.25** (threshold behind a config,
   `EMBEDDING_MIN_SCORE`, to tune against the real model — scores visible only in the
   admin test box, §10), pin the top hit as `best`, group the rest by `year`
   descending, items within a year by score descending. Items already in `exact` are
   deduped out of the semantic sections.
6. Hydrate display fields for the survivors only (one `findMany` per kind) — the
   `findMany` re-applies the scope's `where` clause, so an index-cache bug can never
   leak another tenant's data (defense in depth).

### 6.2 Exact-match pass (and degraded mode)

Semantic similarity is unreliable exactly where humans are precise: amounts, merchant
names, verbatim descriptions. Before the embed call, one cheap SQL pass runs over the
caller's scope:

- `Receipt.merchant / note / originalName` and `LineItem.description /
  Reimbursement.claimDescription` — case-insensitive `contains` of the raw query.
- If the query parses as money (`$214.80`, `214.80`, `-27.98`), also match
  `LineItem.amountCents` / `Reimbursement.totalCents` / `Receipt.extractedTotalCents`
  exactly (via `parseDollarsToCents`).

Results (capped at 10) render as an "Exact matches" strip above the semantic results
and are deduped from them. Cost: two indexed queries at church scale — no FTS engine.
**Degraded mode falls out for free**: when the embed call fails (endpoint down), the
search still returns exact matches plus `degraded:"semanticUnavailable"`, and the UI
says "Smart search is temporarily unavailable — showing exact text matches only."
Search never goes fully dark with the endpoint (§8).

### 6.3 Permission matrix (who sees what)

| Caller (verified role mirror) | scope="mine" | scope="all" (role-holder default) | decidedByMe |
| :-- | :-- | :-- | :-- |
| member | own receipts + own claims | 404 | 404 |
| approver | own | all receipts + all claims | claims where `approverUserId = me` AND status ∈ approved/rejected/paid + receipts attached to those claims |
| treasurer / admin | own | all receipts + all claims | same as approver (a treasurer can also hold assignments) |

`decidedByMe` is **not** denormalized onto the index (it would go stale on every
assignment/decision): the route pre-fetches the caller's decided claim ids + their
attached receipt ids (one indexed query each) into a `Set` used as the scoring
pre-filter. Cheap at this scale; the index stays join-free.

"All claims" includes **drafts** — consistent with the ratified principle below; the
result card shows the `draft` status pill so a searcher knows they are looking at work
in progress.

Duty pauses (`approvalsPaused`/`financePaused`) do **not** narrow search: pauses are
workflow routing, not access revocation (same posture as keeping already-assigned
claims decidable). Role loss does narrow it — the mirror is re-read on every request.

**This is a new cross-tenant read grant — ratified.** The operator's position:
approvers and treasurers should have read access across all reimbursements anyway;
search is simply the first surface built on that principle. ESIGN_DESIGN §6.3
currently enumerates approver-inbox / finance-queue / packet / certificate /
reconcile / `/v/<token>` as the only non-owner reads. Shipping this feature amends
that list with:

> *Role read (ratified): holders of a verified approver/treasurer/admin role may read
> receipts and claims across all tenants — search summaries and receipt files today;
> future role-facing read surfaces may rely on the same grant. Draft claims are
> included. Writes remain owner-only (plus the existing ceremony paths).*

Delivery: the grant itself (file/preview role gate + ESIGN §6.3 amendment + the
security-sweep exception) lands as its **own commit with its own tests, before the
search API commit**, so the authz change is reviewable in isolation:
- `GET /api/receipts/[id]/file` (and `/preview`) gain the role gate beside the owner
  check (an approver clicking a foreign receipt result must see the image).
- `tests/e2e/security.spec.ts`'s cross-tenant-404 sweep gets the deliberate exception,
  exactly as the §6.3 grants did.
- It stays **role-gated by the verified mirror** — never by `ADMIN_EMAILS` (app-
  surface bootstrap, not a data-access grant).

### 6.4 Scoring engine

`src/lib/embeddings/index-cache.ts`: a module-level (globalThis-guarded) cache of the
**active-model** `Embedding` rows decoded into one `Float32Array` matrix + a parallel
metadata array `{kind, targetId, userId, year}`. Invalidation is a version counter
bumped by the worker/delete/cutover paths; the search path reloads lazily when the
version moved. Vectors are unit-length (§3.1), so scoring one query is a dot product
per row — 5 000 items × 2 048 dims ≈ 10 M multiply-adds, ~2–5 ms; memory ~40 MB
(§4 sizing). (If a deployment ever outgrows this, the escape hatch is swapping this
one module for sqlite-vec — nothing else changes.)

### 6.5 Year grouping

The year is **denormalized onto the Embedding row at write time** (`year` column) so
grouping needs no joins:

- **Receipt**: `purchaseDate` prefix (`YYYY` of the transcription string) when it
  looks like a date; else `createdAt` year. A substring read of a transcription for
  display bucketing — not date arithmetic (invariant respected). `purchaseDate` is in
  the staleness fingerprint (§4), so a re-extraction that changes it re-embeds and
  re-buckets the receipt.
- **Claim**: `submittedAt ?? createdAt` year; the submit trigger (§5.2) re-buckets.

## 7. UI design

### 7.1 Placement & entry points

A dedicated **`/search`** page. Entry points, in order of importance:

1. **Inline search pills where the work happens**: a "Search receipts…" pill at the
   top of the Receipts (Shoebox) screen and a "Search claims…" pill on the Claims
   list. Tapping navigates to `/search` with the type filter pre-set. This is the
   primary mobile path — the moment of "where's that receipt?" happens *inside* those
   screens, not in the nav.
2. **NavBar entry**: labeled "Search" alongside Receipts/Claims on desktop widths;
   a magnifier icon (with `aria-label`) on narrow widths. Declared placement — not
   left to the nav's overflow behavior.
3. `Cmd/Ctrl-K` opens `/search` focused (desktop convenience only, never load-bearing;
   it must not steal focus while an IME composition is active elsewhere).

Server component does the usual `currentUserId()` redirect and passes the caller's
role capabilities (may use scope-all? may use decidedByMe?) so the client renders only
the filters this user is allowed to touch. All entry points render only when the
feature is configured and enabled (`EmbeddingSettings.enabled`).

### 7.2 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  🔍 [ Search receipts and claims…               ] [Search]   │
│                                                              │
│  [All types ▾]   [My items | Whole church]   [☑ Claims I     │  ← filter row
│   receipts/claims  segmented, role-holders     decided]        (role-holders only)
│                                                              │
│  EXACT MATCHES ────────────────────────────────────────────  │  ← §6.2, only when
│  ┌─────────┐  Costco  ·  $214.80  ·  "folding chairs"        │    non-empty
│  └─────────┘                                                 │
│                                                              │
│  BEST MATCH ───────────────────────────────────────────────  │  ← pinned global
│  ┌─────────┐  Costco  ·  05/12/2024  ·  $214.80              │    top hit — year
│  │ thumb   │  Not on a claim   [Find in Receipts]            │    grouping never
│  └─────────┘                                                 │    buries it
│  2026 ─────────────────────────────────────────────────────  │
│  ┌─────────┐  CLAIM · Approved · $412.55 · by Grace L.       │
│  │ 📄       │  "Youth retreat supplies" · 210 Youth           │
│  └─────────┘                                                 │
│  2025 ─────────────────────────────────────────────────────  │
│  …                                                           │
└──────────────────────────────────────────────────────────────┘
```

- **Year headers** are sticky section headers, newest year first, **suppressed
  entirely when total results ≤ 5** (three headers over four results is chrome, not
  structure). The pinned Best match answers "just give me the thing" regardless of
  which year it lives in — this keeps the operator-required year grouping from
  burying an old-but-right hit under recent weak ones.
- **No relevance scores in the user UI.** Scores are ordinal, tooltips don't exist on
  touch, and a visible number invites questions it can't answer. Ordering carries the
  signal; exact scores appear only in the admin test box (§10).
- Filter vocabulary is plain: the scope control is a two-segment **"My items / Whole
  church"** (role-holders only; members never see it), and the decided filter reads
  **"Claims I decided"** with helper text "approved or rejected by me — not ones
  still waiting".

### 7.3 Result cards are actions, not dead ends

- **Receipt cards**: thumbnail (`/file`, or `/preview?page=1` for PDFs — same sources
  ReceiptGrid uses), merchant, date, note, owner (whole-church scope only). Then the
  state line, which is the point:
  - **On claims** → status chips ("On claim · Submitted"), each linking to the claim
    surface the viewer is entitled to (own claim → review screen; assigned approver →
    inbox detail; treasurer → finance detail).
  - **Not on any claim** → an explicit "Not on a claim" chip + a **"Find in
    Receipts"** action that deep-links to the Shoebox with the receipt highlighted
    and pre-selected (`/?highlight=<id>`), dropping the user into the existing
    select-→-New-Claim flow. Re-finding a receipt in order to claim it is THE member
    search job; the card must land them one tap from doing it.
  - Tapping the thumbnail opens ReceiptViewer (zoom/pan) as today.
- **Claim cards**: status pill (existing `Common.status.*` labels), total
  (`formatCents`), claimDescription, ministry chips, owner; click-through to the
  entitled surface, else the card is informational (rare: a role-holder viewing a
  foreign draft).

### 7.4 Designing around the 500 ms query embed

The latency budget (~500 ms embed + ~5 ms scoring + hydration) lands at ~600–700 ms —
too slow for search-as-you-type, comfortably fast for explicit search. So:

- **Explicit submit** (Enter or the Search button). No per-keystroke requests — also
  keeps embed load and telemetry proportional to real searches.
- **IME safety (a third of the user base types Chinese)**: Enter is ignored while a
  composition is in progress (`event.isComposing` / `keyCode === 229`) — pinyin/
  zhuyin users pressing Enter to commit 王姐妹 must never fire a search on "wang".
  Unit/e2e covered. The Search button stays full-size on mobile (44 px target) since
  IME users often prefer tapping.
- **Instant acknowledgment**: on submit the input shows an inline spinner and the
  button goes disabled ("Searching…"); previous results stay visible but dimmed
  (opacity + non-interactive) — no layout jump for a sub-second wait. First-ever
  search shows 3 skeleton cards. An `aria-live="polite"` region announces
  "Searching…" then "N results" so the dimming pattern is perceivable non-visually.
- **Stale-response guard**: each submit carries a monotonic id; only the latest
  response renders. In-flight fetches are cancelled via `AbortController` when a new
  submit or a filter change lands.
- **Filter changes re-query without re-embedding** (server LRU hit → ~50 ms), so
  toggling filters feels instant even though it round-trips.
- If the call exceeds ~3 s (endpoint cold start), the spinner gains "Still
  searching…"; on embed failure the exact-match results still render with the
  degraded banner (§6.2) — the error state has content, not just an apology.
- **Freshness is explained in the caller's terms**, not a global footer: the response
  carries `myPendingReceipts/myPendingClaims` (the caller's own queued/running jobs).
  Empty result + own pending items → "Your 2 newest receipts are still being indexed
  — try again in a minute." Non-empty results + pending → a quiet one-line note.
  A draft edited moments ago is covered by the same counts (its debounced job is
  pending). During initial backfill the note falls back to the global pending count.
- Empty state distinguishes "no matches" (offer: check spelling, try fewer words —
  and exact matching was already tried, §6.2) from "nothing indexed yet".

### 7.5 i18n & testids

Every string through `messages/<locale>.json` with translator `context` notes
(the short ones especially: "Whole church", "Claims I decided", "Searching…",
"Not on a claim"). New testids, following the existing convention:
`search-input, search-submit, search-type-filter, search-scope-filter,
search-decided-filter, search-exact-section, search-best-match,
search-group-<year>, search-result-<kind>-<id>, search-find-in-receipts-<id>,
search-pending-note, search-degraded-note, search-empty, shoebox-search-pill,
claims-search-pill` — plus the admin card's `embedding-settings-form,
embedding-test-connection, embedding-save, embedding-skip-probe,
embedding-migration-progress, embedding-cancel-migration, embedding-retry-job-<id>,
embedding-test-query`.

## 8. Failure modes

| Failure | Behavior |
| :-- | :-- |
| Endpoint down during search | exact-match results + `degraded:"semanticUnavailable"` banner (§6.2) — never a dead search page |
| Endpoint down during ingest | jobs retry with backoff (§5.3); queue depth visible in admin; search keeps serving the existing index |
| Job fails 8 times | `status="failed"`, listed in admin with `lastError`; "Retry" re-queues; a later daily sweep also re-queues it (sha mismatch persists) |
| Claim composite exceeds server context | worker halves the items list and retries once (§3.1) before counting a failure |
| Admin enters a bad endpoint/model/dim | the save-time probe (§3.2) rejects it — misconfiguration cannot reach the worker or the index |
| Admin needs to change config while endpoint is down | disable/cancel never probe; "Save without testing" escape is audited (§3.2) — no lockout |
| Endpoint reconfigured out-of-band (dim drift) | provider's dim check errors the job (visible in admin); active index unaffected until vectors actually change |
| Edit races a running embed | generation-conditional finalize (§5.3) — the follow-up job survives and re-embeds; hash short-circuit makes it free if content settled |
| Container crash mid-embed / mid-migration | lease expiry reclaims `running` rows (nextAttemptAt reset to now); migration state is all in SQLite and cutover is transactional — it resumes or re-fires |
| Feature unconfigured | no entry points, `/search` and `/api/search` 404, worker never starts — zero footprint |

## 9. Telemetry (invariant 7) — with a privacy boundary

Every embedding provider call — document ingest **and** query, success **and**
failure — writes an `ExtractionLog` with `kind="embedding"`, but **never verbatim
content**, because search queries are PII-adjacent and composites contain claim
content that must not outlive the claim in a log with no retention story:

- `prompt` = a structural label only: `"query"`, `"receipt <id>"`, `"claim <id>"`.
- `parsedJson` = `{dim, targetKind?, targetId?, promptSha256, promptChars}` — enough
  to correlate, count, and dedupe without storing what was typed. Never the vector,
  never the query text, never the composite (rawResponse stays null too).
- `model` = the model actually used (active or target; `"mock"` under mock),
  `durationMs`, `status`/`errorMessage` as usual. Provider error messages are safe
  (llama.cpp errors carry no input content).
- `kind="embedding"` rows are **excluded from the tuning UI** (`/api/extraction-logs`
  list) — they are operational, not extraction-quality data — and the daily sweep
  deletes embedding-kind logs older than **90 days**.

This is a deliberate, documented narrowing of invariant 7's "log the prompt" for one
kind: the *call trail* stays complete (who/what/when/how long/outcome); the *content*
is deliberately not retained. Queue mutations themselves are not AuditEvents (no human
action); admin actions **are**: `update-embedding-config` (field diff, API key
redacted, probe-skipped flag), `retry-embedding`, `embedding-migration-cancel`.
(Cutover is automatic — it logs an ExtractionLog-style operational line via the
worker, not an AuditEvent, since no human acted.)

## 10. Admin surface

A "Search index" card on `/admin` behind the existing `isAppAdmin()` gate
(API under `/api/admin/…`):

- **Backend settings** (§3.2): endpoint, API key (write-only field, shows
  fingerprint), model, dim, query prefix, enabled toggle; "Test connection" runs the
  probe standalone; "Save without testing" escape per the probe policy.
- **Queue health**: counts by job status, oldest queued age, failed-job list with
  `lastError` + per-row and bulk Retry.
- **Migration progress** (visible while `migrationState="indexing"`): progress bar
  (n/m target-model rows present) + **Cancel**. Cutover is automatic on completion.
- **Test query box**: run a search as-admin with visible scores — the only place
  scores render (threshold tuning, §6.1) and the natural smoke test after any
  settings change.
- **Rebuild index**: re-embeds everything on the current model (forced-staleness
  sweep) — the hammer for "the endpoint was silently swapped under me".

## 11. Testing plan

- **Unit** (Vitest, `EMBEDDING_MOCK`): cosine/top-K/threshold/year-grouping/best-match
  pure functions; exact-match pass (money parsing → cents equality, contains scoping);
  queue state machine — enqueue-dedupe, backoff schedule, lease reclaim (resets
  `nextAttemptAt`), failed-terminal, **generation race** (enqueue during running →
  finalize's conditional write leaves the re-queued job live; hash short-circuit makes
  the follow-up free), **draft debounce** (successive mutations push `nextAttemptAt`);
  composite builder (money formatting, CJK content untouched, excluded rows omitted,
  byte-budget truncation, draft vs frozen); receipt fingerprint covers
  note/merchant/purchaseDate; permission matrix as a table test —
  member/approver/treasurer × scope × filter, asserting 404s exactly where the matrix
  says; decidedByMe prefetch sets; **migration lifecycle** — model edit → dual-model
  enqueue → coverage → auto-cutover flips index + purges old rows atomically; cancel
  purges target rows; key-only edit does NOT start a migration; saves rejected while
  indexing; probe policy (disable never probed; skip-probe audited).
- **e2e** (chromium, mock embeddings, `EMBEDDING_DRAFT_IDLE_MS` shrunk to ~1 s):
  upload → worker indexes → search finds it; a draft claim becomes searchable after
  the idle window and an edit refreshes its embedding; IME composition Enter does not
  fire a search (`isComposing` guard — CDP-dispatched composition events); "Find in
  Receipts" lands on the Shoebox with the receipt highlighted; approver default scope
  is whole-church and can open a foreign receipt image; member `scope:"all"` → 404;
  "Claims I decided" returns only decided claims; degraded mode (endpoint 500) shows
  exact matches + banner; admin changes the model → search works mid-migration →
  auto-cutover → search works on the new model; security sweep updated for the
  ratified grant.
- **Mock design note**: the mock must be similarity-meaningful (bag-of-tokens folded
  into the space), not random — e2e asserts *ranking*, not just presence.

## 12. Endpoint questions — RESOLVED by live probing (§3.1)

Answered 2026-07-16 against the real endpoint (`scripts/probe-embedding-endpoint.mjs`
re-verifies on demand):

1. **Image encoding**: images do NOT go through `/v1/embeddings` (text-only there);
   they go through native `/embeddings` as raw base64 in `multimodal_data` with a
   `<__media__>` token per image — no data-URI. Text+image pairing in one input
   works. Bearer auth on both routes.
2. **Dimension**: 2048, unit-normalized at the source. No MRL truncation offered by
   the server; the full-dim matrix is fine at church scale (§6.4). If it ever
   appears, a dim change is just a §3.3 migration.
3. **Batching**: yes on both routes (array input on `/v1`; multiple `content` items
   on native — results identical to singles). Worker stays sequential; a 2-item
   native batch took ~2× a single, so batching buys queueing simplicity, not GPU
   time.
4. **Instruction prefix**: confirmed working — `"Instruct: Retrieve the receipt
   matching the query. Query: "` is the `queryPrefix` seed (§3.2; admin-tunable, no
   re-index needed).

New facts the probe surfaced that the design now depends on: **no WebP, no PDF** at
the endpoint (ingest normalizes everything to JPEG), **image size → latency** (≤640 px
inputs, `EMBEDDING_MAX_PX`), and an **8192-token server context** (bounds the claim
composite via a ~4 000-byte budget + shrink-and-retry).

## 13. Build order

1. Schema + migration (3 tables, WAL pragmas); provider (verified contract, §3.1 —
   `scripts/probe-embedding-endpoint.mjs` doubles as its spec) + mock; settings
   accessor with env seed + probe policy; composite/fingerprint builders.
2. **Role-read grant commit** (§6.3): file/preview role gate + ESIGN §6.3 amendment +
   security-sweep exception + tests — authz reviewable in isolation, before search.
3. Worker (`instrumentation.ts` + guards) + triggers + backfill/reconcile sweep.
4. `/api/search`: exact pass + index cache + permission matrix + decidedByMe prefetch
   + degraded mode.
5. `/search` UI + entry points (pills, NavBar) + i18n catalogs (en/zh-Hans/zh-Hant).
6. Admin card: settings + queue health + migration progress + test query box.
7. Docs graduation: new invariants into `CLAUDE.md` / `DATA_MODEL.md`.
