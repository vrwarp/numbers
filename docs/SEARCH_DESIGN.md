# Semantic search across receipts and claims — design

Status: **FINAL (rev 6) — signed off by 5 rounds of parallel UX + engineering
critique; endpoint contract verified live**
(§3.1, 2026-07-16 — re-check anytime with `scripts/probe-embedding-endpoint.mjs`).
Companion to `docs/ESIGN_DESIGN.md` (this feature amends its §6.3 read-grant list) and
`docs/agent/DATA_MODEL.md` (three new tables + one new Receipt column).

## 1. Goal

Let users find receipts and claims by meaning, not exact text: "the projector we bought
for VBS", "that Costco run with the returned chairs", "王姐妹's retreat snacks" — and
*also* by the exact fragments people actually remember ("$214.80", "Costco"), via a
cheap exact-match pass that runs beside the semantic one (§6.2).

- **Members** search their own receipts and their own claims. Results are levers, not
  dead ends: an unclaimed receipt offers a path back into the claiming flow, a claimed
  one leads to its claim and status.
- **Approvers** search **all** receipts and **all** claims (default scope — their
  canonical lookup is someone else's claim), with a browseable view of claims they
  decided.
- **Treasurers** (and admins) likewise search everything by default.
- Ranked by cosine similarity of a Qwen multimodal embedding; presented **grouped by
  year**, with the top hit surfaced so grouping never buries it (§7.2).
- **All claims are indexed, drafts included**: a draft becomes searchable once left
  unchanged for **10 minutes** (a debounce — active editing never burns 15 s embeds
  per keystroke, §5.2); frozen claims index immediately.
- The embedding backend (endpoint, model, dimension) is **operator-changeable from the
  admin interface at runtime** (§3.3): a model change wipes and rebuilds the index in
  the background while the exact-match pass keeps search useful.

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
  milliseconds; sqlite-vec et al. are complexity we don't need. Revisit only if corpus
  size × dim makes the resident matrix a memory problem (see §6.4).
- No search *engine* (FTS5, ranking DSLs). The exact-match pass (§6.2) is a scoped
  table scan — fine at this scale, and said plainly.
- No zero-downtime model migration. A model change degrades semantic search for the
  hours the rebuild takes (~4 h/1 000 items); the exact-match pass and an explicit
  progress notice carry the gap (§3.3). Two engineering reviews agreed the shadow
  re-index this replaced was the design's biggest over-build.
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
  hardware-receipt image 0.34 (and symmetrically for a hardware query). The probe
  suite **will include Chinese-query → English-receipt cases** (and vice versa;
  build-order step 1) so the bilingual user base's retrieval quality is verified,
  not assumed.
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
  The downscaled JPEG is produced in memory per embed (sharp pipeline, no temp files).
- **Server context is 8192 tokens** — bounds the claim text composite (§5.1). Token
  counting is not available client-side, so the composite uses a conservative byte
  budget (~4 000 UTF-8 bytes, well under 4 k tokens even for CJK-heavy text, leaving
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
                                   cfg = a ModelConfig (§3.2); the provider is
                                   stateless about which model is current
src/lib/embeddings/mock.ts         EMBEDDING_MOCK=1 — deterministic hash-based vectors
                                   (token-bag folded into the vector space so that
                                   "costco" query ≈ costco fixture; no network).
                                   Vectors are salted with cfg.model so two mock
                                   "models" are deliberately incompatible (rebuild
                                   tests are real), and a query containing
                                   __EMBED_FAIL__ throws — the degraded-mode lever
                                   for tests
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
model EmbeddingSettings {
  id          String   @id @default(cuid())
  enabled     Boolean  @default(false)
  endpoint    String   @default("")
  apiKey      String   @default("")   // stored in SQLite on the /data volume —
                                      // same trust domain as everything else there
  model       String   @default("")
  dim         Int      @default(0)
  // Query-side instruction prefix (Qwen embedding models score better with one);
  // editable because it is model-specific. Changing it only affects queries —
  // no re-index needed, but the query LRU keys on it (§6.1).
  queryPrefix String   @default("")
  // Semantic score floor (×1000, integer — SQLite/Prisma float hygiene).
  // Same edit class as queryPrefix: apply in place, no probe, no re-index.
  // The admin test box shows scores; this is the knob next to the dial.
  minScoreMilli Int    @default(250)
  updatedAt   DateTime @updatedAt
}
```

Resolution order, read through one accessor (`embeddingSettings()`):
**DB row → seeded on first read from `EMBEDDING_*` config values** (which themselves
resolve config.json → env, per the existing `configValue()` chain). After that first
seed, the DB row is authoritative and the admin UI is the way to change it — env edits
no longer override silently (the admin card shows a hint when env and DB disagree).
`EMBEDDING_MOCK=1` short-circuits everything (tests/dev). **In dev
(`NODE_ENV=development`) the env seed and the worker additionally require
`EMBEDDING_DEV=1`** — a `.env` holding real endpoint values must never silently start
a backfill against a production GPU from someone's laptop.

| Var | Class | Notes |
| :-- | :-- | :-- |
| `EMBEDDING_ENDPOINT` | seed | base URL (serves both `/v1/embeddings` and native `/embeddings`); feature is OFF until some config exists (no entry points, routes 404, worker idle) |
| `EMBEDDING_API_KEY` | seed | bearer token |
| `EMBEDDING_MODEL` | seed | model id string, stored on every vector row (`qwen3-vl-embedding-2b`; llama.cpp ignores the request field, but it is our row-identity key) |
| `EMBEDDING_DIM` | seed | vector dimension — optional: the probe detects it (§10), this seeds a headless deploy (2048 for qwen3-vl-embedding-2b) |
| `EMBEDDING_QUERY_PREFIX` | seed | instruction prefix for query embeds — confirmed effective: `"Instruct: Retrieve the receipt matching the query. Query: "` |
| `EMBEDDING_MIN_SCORE` | seed | default 0.25 — seeds `minScoreMilli`; thereafter tuned in the admin card next to the test box |
| `EMBEDDING_MAX_PX` | plumbing | default 640 — long-side cap for image inputs (§3.1: 15 s vs 90 s per embed, cos 0.982 agreement) |
| `EMBEDDING_TIMEOUT_MS` | plumbing | default 120000 — a 15 s embed with queueing ahead of it needs headroom |
| `EMBEDDING_DRAFT_IDLE_MS` | plumbing | default 600000 — the 10 min draft-idle debounce (§5.2); tests shrink it |
| `EMBEDDING_POLL_MS` | plumbing | default 15000 — worker idle poll; e2e relies on the in-process wake (§5.3), not on shrinking this |
| `EMBEDDING_DEV=1` | flag | dev only: allow env seed + worker under `next dev` |
| `EMBEDDING_MOCK=1` | flag | deterministic vectors, no network (vitest sets it via `test.env` in `vitest.config.ts`; e2e via `tests/e2e/start-server.sh`) |

**Probe policy (no admin lockout).** The live probe (embed a fixed test string;
**10 s timeout**, independent of `EMBEDDING_TIMEOUT_MS`) runs only when a save would
make the worker/search *do more*: enabling the feature, or changing endpoint, model,
or API key while enabled (matching §3.3's per-field classification — a bad key
rotation should fail at save, not at the next embed). It never gates turning `enabled` off or editing
`queryPrefix`/`minScoreMilli`. **The probe returns the detected vector dimension** —
the admin never types "2048": the card shows "Detected: 2048" read-only and saves it
(a manual dim field appears only under "Save without testing", the
endpoint-is-down-and-I-know-it escape, audited as such). A dead endpoint can never
lock the admin out of their own config. A "Test connection" button runs the same
probe standalone. Every settings change writes an `AuditEvent`
(`action="update-embedding-config"`, detail = field diff with the API key redacted to
a fingerprint).

**API-key readback contract** (not just a UI affordance): the admin settings **GET
returns `apiKeyFingerprint` + `apiKeySet: boolean`, never the key**; a PUT with the
field absent or empty preserves the stored key. A test asserts the GET body never
contains the stored key string — the bearer token must not ride into every admin page
load and browser cache.

### 3.3 Changing the model — wipe and rebuild

Query vectors are only comparable to document vectors from the **same model**, so a
model change invalidates the whole index. The design accepts a degraded window instead
of maintaining a shadow index (see Non-goals):

- **Edit classification** (per-field): API key or endpoint URL alone → probe (if
  enabled) and apply in place — a credential rotation or a host move serving the
  *same model* keeps every vector valid. `queryPrefix`/`enabled` → apply in place.
  **Model or dim → reset**: one transaction swaps the settings row and deletes ALL
  `Embedding` and `EmbeddingJob` rows; the admin handler then **synchronously runs
  the sweep** (`kickSweep()`, exported by the worker module) so the rebuild starts
  immediately — the sweep's own schedule is start-of-worker + daily (§5.4), so
  without this kick nothing would fire until restart. The index rebuilds over the
  next hours at priority 1.
- **During the rebuild** search still works: the exact-match pass (§6.2) is untouched,
  semantic results grow as vectors land (newest-priority items first), and the UI
  shows the standard pending notice with the global count (§7.4). The admin card
  shows rebuild progress (n/m).
- The query LRU keys on `(model, queryPrefix, query)` (§6.1) and the index cache loads
  only current-model rows, so no stale-space vector can ever be scored against a
  new-model query — the `model` column on `Embedding`/`EmbeddingJob` is the row's
  identity, and rows from an interrupted previous model are purged by the sweep.
- "Rebuild index" in the admin card is the same operation minus the settings swap
  (forced-staleness sweep) — the hammer for "the endpoint was silently swapped under
  me".

## 4. Data model

Three new tables (append to `prisma/schema.prisma`; migration committed as usual):
`EmbeddingSettings` (§3.2), plus the vector store and the queue below — and one new
column on `Receipt`:

```prisma
// On Receipt: sha256 (hex) of the stored file bytes, stamped wherever the file
// is (re)written — upload, image edit, restore-original — and lazily at first
// embed for pre-feature rows (default ""). Lets the reconcile sweep detect
// staleness without re-reading files off disk daily.
fileSha256 String @default("")
```

```prisma
// One vector per indexed document per model (model changes wipe the table, but
// model stays part of row identity so an interrupted change can never mix
// vector spaces). targetId is a Receipt.id or Reimbursement.id (plain string,
// no FK — rows are deleted by the ingest code alongside their target, and the
// queue must be able to reference not-yet-indexed targets).
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
  // detected by rebuilding this from DB columns and comparing — no file reads.
  //   receipt: sha256(Receipt.fileSha256 ‖ note ‖ merchant ‖ purchaseDate)
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
  // Denormalized owner so the per-search "your items still indexing" counts
  // (§7.4) are one indexed query, not a subquery per kind.
  userId        String
  model         String    // embed with THIS model
  status        String    @default("queued") // queued | running | done | failed
  // Bumped by every enqueue-upsert. The worker records it when claiming and its
  // terminal write is conditional on it (§5.3) — an enqueue racing a running
  // embed can therefore never be lost.
  generation    Int       @default(0)
  // 0 = live event (new upload / new packet), 1 = backfill/rebuild. The worker
  // drains priority 0 first so fresh items don't wait behind a 4-hour sweep.
  priority      Int       @default(0)
  attempts      Int       @default(0)
  nextAttemptAt DateTime  @default(now())
  // Crash-safety lease: a "running" row whose lease has expired is reclaimable.
  leaseExpiresAt DateTime?
  lastError     String    @default("")
  // Fingerprint of the input at the moment the job went terminal-failed. The
  // sweep re-enqueues a failed job ONLY when the rebuilt fingerprint differs
  // (content changed) — otherwise failed stays failed instead of re-burning
  // 8 retries of GPU time per day forever (§5.4).
  failedSourceSha256 String @default("")
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@unique([kind, targetId, model])
  @@index([status, priority, nextAttemptAt])
  @@index([userId, status])
}
```

Sizing: 2048 dims × 4 bytes = **8 KB/vector**; 5 000 items ≈ 40 MB in SQLite and
~40 MB resident in the index cache. Fine for the single-container deployment; revisit
only past ~20 k items.

Deletion: the receipt DELETE route and claim DELETE route also delete the matching
`Embedding` + `EmbeddingJob` rows (no FK cascade — do it in the route transaction).
The sweep GCs any survivors (§5.4).

**SQLite concurrency** (corrected twice — final form): `busy_timeout` is
per-connection and Prisma pools connections, so neither a startup pragma nor
deployment-config edits are reliable (DATABASE_URL is set independently in the
Dockerfile, `.env`, `.env.example`, and `tests/e2e/start-server.sh`, and operators can
override it). The mechanism therefore lives in **`src/lib/prisma.ts`**, the one
uncircumventable anchor: the client is constructed with `datasourceUrl =
DATABASE_URL + "?connection_limit=1"` (full write serialization — church scale
tolerates it; the streaming claim routes hold no transactions across their LLM calls,
so nothing starves) and runs `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000` once
at creation. The worker NEVER holds a transaction across the ~15 s provider call —
claim job (short write) → embed (no txn) → finalize (short write).

## 5. Ingest pipeline (the 15 s path)

### 5.1 What gets embedded

**Receipts — the stored image + its text metadata.** Input to `embedImage()` is the
already-compressed stored file (`filePath`, ~100 KB WebP — never the original), which
the provider normalizes in memory to a **≤640 px JPEG**: the endpoint rejects WebP
outright and an undownscaled image costs ~90 s instead of ~15 s for a near-identical
vector (§3.1). The user's `note` + extracted `merchant` ride in `prompt_string` ahead
of the `<__media__>` token — which is why they are part of the staleness fingerprint
(§4). PDF receipts embed their **page-1 raster**, reusing the existing preview
machinery (`src/lib/pdf/preview.ts` cache; generate on demand if not yet cached) —
those cached pages are WebP too, so they pass through the same JPEG normalization.

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
| Receipt uploaded (`POST /api/receipts`) | stamp `fileSha256`; enqueue `{kind:"receipt"}`, priority 0 |
| Receipt image edited / restored (`/api/receipts/[id]/edit`) | re-stamp `fileSha256`; re-enqueue |
| Receipt note edited (`PATCH /api/receipts/[id]`) | re-enqueue (note is embedded text, §5.1) |
| Receipt extraction (re)stamped — claim create, add-receipts, manual-entry PATCH | re-enqueue the **receipt** (merchant/purchaseDate are embedded text + the year key) |
| Any draft-claim content mutation (claim created, claim PATCH, line-item PATCH/split/merge, receipts added/removed, manual entry) | enqueue `{kind:"claim"}`, priority 0, **`nextAttemptAt = now + 10 min`** — the draft-idle debounce, see below |
| Claim PDF generated (`POST …/pdf`) | re-enqueue `{kind:"claim"}` with `nextAttemptAt = now` (content is frozen; index immediately); regeneration likewise |
| Claim submitted (e-sign) | re-enqueue claim (status/year may shift: `submittedAt` becomes the year key) |
| Claim reverted to draft (`revert/route.ts` — the single revert path) | re-enqueue with the draft debounce (stays searchable; refreshes if post-revert edits change content) |
| Receipt / claim deleted | delete `Embedding` + job rows (in the route transaction) |
| **No trigger (deliberate)**: approve/reject (`decision/route.ts`), mark-paid (`paid/route.ts`), reconcile status repairs (`reconcile/route.ts`) | status is hydrated live at query time (§6.1 step 6), never embedded; the year key derives from `submittedAt`, which only the submit route sets. The reconcile withdraw-repair (submitted → generated with `submittedAt` left set) can leave a stale year bucket until the next content re-embed — accepted, rare and cosmetic |

Route anchors for the rows above: upload = the per-file loop in
`src/app/api/receipts/route.ts` POST; image edit = `receipts/[id]/edit/route.ts`;
note = `receipts/[id]/route.ts` PATCH; extraction restamps = `src/lib/claims.ts`
consumers (claim POST, `[id]/receipts` POST, manual-entry PATCH); submit =
`reimbursements/[id]/submit/route.ts` (the only place `submittedAt` is written —
`esign/server.ts` writes roster/record mirrors, never claim status).

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

A singleton loop inside the app process, started from **`src/instrumentation.ts`**
(new file — this repo uses the `src/` layout, and Next.js silently ignores a
root-level `instrumentation.ts` when `src/` exists; standalone output compiles it
into `server.js`, and Prisma is already in `serverExternalPackages`). Registration is
guarded:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;           // never on edge
  if (process.env.NEXT_PHASE === "phase-production-build") return; // never at build
  if (process.env.NODE_ENV === "development"
      && !process.env.EMBEDDING_DEV && !process.env.EMBEDDING_MOCK) return; // §3.2
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
  job = first queued with nextAttemptAt <= now AND model == settings.model,
        ORDER BY priority, createdAt
  if none → sleep EMBEDDING_POLL_MS (default 15 s). The early-wake mechanism is an
            exported wakeEmbeddingWorker() on the worker module (globalThis-guarded),
            called in-process by the enqueue helpers — e2e determinism rests on this
            wake plus a shrunk EMBEDDING_DRAFT_IDLE_MS, never on the poll interval
  claim: mark running, leaseExpiresAt = now + 5 min, remember gen = job.generation
  build input (§5.1); stamp Receipt.fileSha256 if it was empty (pre-feature row)
  if rebuilt sourceSha256 already matches the stored Embedding row
    → finalize as done (same generation-conditional write as below), NO provider call
  provider call (~15 s, NO db transaction held) → verify dim → normalize
  finalize (single short transaction), ORDER MATTERS:
    1. updateMany job → done WHERE id AND status="running" AND generation = gen
       → 0 rows affected: an enqueue raced us (job re-queued, gen+1) OR the job
         was deleted (target gone). SKIP the vector write entirely — never
         persist a possibly-stale vector; the follow-up run re-embeds (hash
         short-circuit makes it free if content settled back).
    2. re-check the target row exists (same txn); gone → done, write nothing.
    3. upsert Embedding row for (kind, targetId, job.model).
  write ExtractionLog kind="embedding" (§9); apply DELTA to the index cache
  (upsert this one row in-process, §6.4 — never a version bump per job)
on error:
  attempts++; lastError = message
  attempts < 8 → status queued, nextAttemptAt = now + min(30 s × 2^attempts, 1 h)
  else       → status failed, failedSourceSha256 = current fingerprint
               (surfaces in the admin panel, §10; manual retry re-queues; the
               member loses nothing visible — the item still surfaces via the
               exact-match pass, just not semantically)
```

**Concurrency 1.** Each call holds the (self-hosted, single-GPU llama.cpp) endpoint
for ~15 s; parallel calls would just queue server-side. Make it a config
(`EMBEDDING_CONCURRENCY`, default 1) for a beefier endpoint later.

### 5.4 Backfill / reconcile sweep

On worker start (and once a day thereafter) a sweep enqueues, at **priority 1**, every
receipt and every claim — including drafts whose `updatedAt` is ≥ 10 min old — that
either has no `Embedding` row for the current model or whose fingerprint, rebuilt
**from DB columns only** (`fileSha256`/note/merchant/purchaseDate; composite from the
claim rows — no file reads), no longer matches (covers: pre-feature rows, rows that
missed a trigger, edits that raced; recently-touched drafts are skipped because their
debounced job already exists). **Failed jobs are exempt unless their content
changed**: a failed job re-enqueues only when the rebuilt fingerprint differs from
`failedSourceSha256` (or the model changed) — a permanently unreadable item must not
re-burn 8 retries of single-GPU time every day and repopulate the admin's triage list
forever. The sweep also GCs: `Embedding`/`EmbeddingJob` rows whose model isn't the
current one (interrupted model change) or whose **target row no longer exists**
(deletion racing an in-flight embed — the backstop behind §5.3's in-transaction
check). Idempotent, pure-DB, cheap. At ~15 s per item a 1,000-receipt
history backfills in ~4 h of quiet background work while new uploads still jump the
line at priority 0.

## 6. Query path (the 500 ms path)

### 6.1 API

```
POST /api/search        { query: string (0..300),
                          types?: ("receipt"|"claim")[]   default both,
                          scope?: "mine" | "all" | "decided",
                                  // default: "all" for verified approver/treasurer/
                                  // admin, "mine" for members; "decided" = claims I
                                  // approved/rejected (+ their receipts) — the one
                                  // scope where an EMPTY query is allowed and
                                  // returns the set newest-first (browse mode)
                          cursor?: string   // browse mode only: pagination (20/page)
                        }
→ 200 {
    exact:  [ …item…, cap 3 shown + exactTotal ],   // §6.2, ranked first
    best:   { …item… } | null,     // top semantic hit; null whenever exact ≠ []
    groups: [{ year: 2026, items: [
      { kind: "receipt", id, score?, merchant, purchaseDate, note, originalName,
        ownerName?,                     // scope="all"/"decided" only
        claims: [{id, status}] },       // empty array = "Not on a claim" (§7.3)
      { kind: "claim", id, score?, status, totalCents, claimDescription,
        ministries: string[], ownerName?, createdAt } ] }],
    indexed: { myPendingReceipts: n, myPendingClaims: n, myNextReadyAt?: iso,
               // rebuildPending: GLOBAL queue depth — present ONLY while a
               // backfill/rebuild is running, rounded to a coarse figure (a
               // deliberate, stated aggregate exception to tenant scoping —
               // §6.3; per-user activity must not be inferable from it)
               rebuildPending?: n },
    degraded?: "semanticUnavailable",              // §6.2 fallback marker
    nextCursor?: string                            // browse mode only
  }
```

Standard shape: `handleApi` + `requireUserId`, zod body, POST (queries in bodies, not
URLs — they contain user content and shouldn't land in access logs).

Flow:

1. Resolve caller's role from the verified `User.role` mirror. `scope:"all"` or
   `"decided"` from a plain member → **404** (indistinguishable from not-found, per
   invariant 2). Empty query outside `scope:"decided"` → 400.
2. Run the **exact-match pass** (§6.2) — pure SQL, no provider dependency.
3. Embed the normalized query (`queryPrefix + query`) through a small **server-side
   LRU** keyed on `(model, queryPrefix, normalized query)` (~200 entries, 15 min
   TTL): repeated searches, back-navigation, and filter tweaks skip the ~500 ms
   entirely. Filter changes never re-embed (the vector doesn't depend on filters).
   If this call fails, return exact results with `degraded:"semanticUnavailable"`
   instead of 502ing the whole search (§6.2).
4. Score against the in-memory index (§6.4) **after** applying the permission scope
   (§6.3) — tenant scoping is a pre-filter, never a post-filter.
5. Keep the global top **50** with score ≥ `minScoreMilli/1000` (default 0.25;
   tuned in the admin card beside the test box where scores are visible, §10).
   Dedupe anything already in `exact`. Pin the top remaining hit as `best`
   **only when `exact` is empty** — when exact hits exist they ARE the best match,
   and a "Best match" header over leftovers would lie (§7.2). Group the rest by
   `year` descending, items within a year by score descending.
6. Hydrate display fields for the survivors only (one `findMany` per kind) — the
   `findMany` re-applies the scope's `where` clause, so an index-cache bug can never
   leak another tenant's data (defense in depth).

### 6.2 Exact-match pass (and degraded mode)

Semantic similarity is unreliable exactly where humans are precise: amounts, merchant
names, verbatim descriptions. Before the embed call, one cheap SQL pass runs over the
caller's scope. Correctness details (SQLite, bilingual input):

- The query is **NFKC-normalized and lowercased** server-side first — full-width IME
  digits/punctuation (２１４．８０) become half-width, so Chinese-input amounts and
  merchant fragments match half-width stored text.
- **Tokenized AND**: the query is whitespace-split and every term must match
  (each term against any of the columns) — "Costco folding chairs" narrows the
  "Costco" result set instead of vanishing because no single field contains the
  whole phrase.
- Matching uses one raw `LOWER(col) LIKE ? ESCAPE '\'` query per kind with `%`/`_`
  escaped in the term (Prisma `contains` on SQLite is ASCII-case-sensitive-partial
  and does not escape wildcards). This is a **scoped table scan**, not an indexed
  lookup — fine at church scale, stated honestly.
- Columns: `Receipt.merchant / note / originalName`, `LineItem.description`,
  `Reimbursement.claimDescription`. If any token parses as money after normalization
  (`$214.80`, `214.80`, `-27.98`, `¥214.8`, `214.8元` — currency markers stripped),
  also match `LineItem.amountCents` / `Reimbursement.totalCents` /
  `Receipt.extractedTotalCents` exactly via `parseDollarsToCents`.

The strip renders at most 3 cards + "Show all N exact matches" (§7.2), deduped from
the semantic sections. **Degraded mode falls out for free**: when the embed call
fails, the search still returns exact matches plus `degraded:"semanticUnavailable"`,
and the UI explains the *outcome*: "Right now search only finds results containing
your exact words. Descriptive search will be back soon." Search never goes fully dark
with the endpoint (§8).

### 6.3 Permission matrix (who sees what)

| Caller (verified role mirror) | scope="mine" | scope="all" (role-holder default) | scope="decided" |
| :-- | :-- | :-- | :-- |
| member | own receipts + own claims | 404 | 404 |
| approver | own | all receipts + all claims | claims where `approverUserId = me` AND status ∈ approved/rejected/paid + receipts attached to those claims; empty query = browse newest-first |
| treasurer / admin | own | all receipts + all claims | same as approver (a treasurer can also hold assignments) |

`scope:"decided"` is **not** denormalized onto the index (it would go stale on every
assignment/decision): the route pre-fetches the caller's decided claim ids + their
attached receipt ids (one indexed query each) into a `Set` used as the scoring
pre-filter. Cheap at this scale; the index stays join-free.

"All claims" includes **drafts** — consistent with the ratified principle below; the
result card shows the `draft` status pill so a searcher knows they are looking at work
in progress.

**Duty pauses (A10) narrow the grant, per-duty** (`src/lib/roles.ts`
`searchCapabilities`). The verified role sets the ceiling; the self-service pause
toggles lower it, computed fresh on every request alongside the role:

- **`scope="all"` / foreign receipt file reads** require **at least one active
  (un-paused) duty** the role grants — the holder is still serving in some
  cross-tenant capacity. An approver who pauses Approvals loses it (no fallback
  duty); a treasurer who pauses only Approvals keeps it (Finance still active); it
  goes once every relevant duty is paused. An admin keeps it via the admin duty even
  with Approvals+Finance paused.
- **`scope="decided"`** requires the **Approvals duty active** — it IS the approver's
  decision set — so a treasurer who pauses Approvals loses "Claims I decided" while
  keeping whole-church. (Active Approvals implies whole-church, so decided ⟹ all.)

A fully-paused role-holder reads exactly like a member: `scope=all`/`decided` → 404,
foreign files → 404, and the UI renders no scope control (the capability genuinely
went away — not a cosmetic hide). Role loss narrows it the same way. The grant NEVER
derives from `ADMIN_EMAILS` — only the verified role mirror.

**This is a new cross-tenant read grant — ratified.** The operator's position:
approvers and treasurers should have read access across all reimbursements anyway;
search is simply the first surface built on that principle. ESIGN_DESIGN §6.3
currently enumerates approver-inbox / finance-queue / packet / certificate /
reconcile / `/v/<token>` as the only non-owner reads. Shipping this feature amends
that list with:

> *Role read (ratified): holders of a verified approver/treasurer/admin role may read
> receipts and claims across all tenants — search summaries and receipt files today;
> future role-facing read surfaces may rely on the same grant. Draft claims are
> included, and so are **receipts never placed on any claim** (Shoebox staging photos
> and their notes) — the operator's instruction was "search across all receipts",
> which is deliberately broader than "all reimbursements"; this sentence exists so
> that breadth is signed off, not accidental. Writes remain owner-only (plus the
> existing ceremony paths). One aggregate exception rides along: while a
> backfill/rebuild runs, ALL users see a coarse global queue-depth figure
> (`rebuildPending`, §6.1) — no per-user activity may be inferable from it.*

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
**current-model** `Embedding` rows decoded into one `Float32Array` matrix + a parallel
metadata array `{kind, targetId, userId, year}`. Two rules keep it cheap during the
very period it's under most load (a 4-hour backfill finalizing a job every ~15 s):

- **Delta application**: the worker upserts/removes its own row in the in-process
  cache after each finalize — a per-job version bump + full reload would otherwise
  tax every search with a 40 MB `findMany` for the whole backfill. The version
  counter forces a full reload only on delete/reset/rebuild.
- **Single-flight**: concurrent searches that do find a moved version share one
  in-flight reload promise; nobody loads the matrix twice.

Vectors are unit-length (§3.1), so scoring one query is a dot product per row —
5 000 items × 2 048 dims ≈ 10 M multiply-adds, ~2–5 ms; memory ~40 MB (§4 sizing).
(If a deployment ever outgrows this, the escape hatch is swapping this one module for
sqlite-vec — nothing else changes.)

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
   list. Tapping navigates to `/search` with the type filter pre-set **and the input
   focused** (keyboard up — the user just tapped something that looks like a search
   box). This is the primary mobile path — the moment of "where's that receipt?"
   happens *inside* those screens, not in the nav.
2. **NavBar entry**: labeled "Search" alongside Receipts/Claims on desktop widths;
   a magnifier icon (with `aria-label`) on narrow widths. Declared placement — not
   left to the nav's overflow behavior.
3. `Cmd/Ctrl-K` opens `/search` focused (desktop convenience only, never load-bearing;
   it must not steal focus while an IME composition is active elsewhere).

Server component does the usual `currentUserId()` redirect and passes the caller's
role capabilities so the client renders only the controls this user is allowed to
touch. All entry points render only when the feature is
configured and enabled (`EmbeddingSettings.enabled`).

### 7.2 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  🔍 [ Search receipts and claims…               ] [Search]   │
│  (Receipts only ✕)          ← chip, only when a pill pre-set │
│                               the type; no dropdown          │
│  [My items | Whole church | Claims I decided]                │  ← one segmented
│   (role-holders only; members see no control row)               scope control
│                                                              │
│  EXACT MATCHES ────────────────────────────────────────────  │  ← ≤3 cards +
│  ┌─────────┐  Costco  ·  $214.80  ·  "folding chairs"        │    "Show all 7"
│  └─────────┘                                                 │    only when found
│                                                              │
│  2024 ─────────────────────────────────────────────────────  │  ← year sections;
│  ┌─────────┐  Costco  ·  2024年5月12日  ·  $214.80            │    "Best match"
│  │ thumb   │  Not on a claim   [Find in Receipts]            │    pin appears
│  └─────────┘                                                 │    ONLY when no
│  2026 …                                                      │    exact matches
└──────────────────────────────────────────────────────────────┘
```

- **Control surface is minimal**: input + button, the scope segment (role-holders
  only), and a removable type chip that exists only when an entry pill pre-set it
  ("Receipts only ✕") — there is **no persistent type dropdown**; kind is
  self-evident from the cards and the chip fixes the pill-promise mismatch (a
  "Search receipts…" pill must not land on a silently-filtered generic page). The
  API keeps `types` for the pills and the chip.
- **At most two kinds of scaffolding are ever visible**: the exact strip (when
  non-empty, capped at 3 + "Show all N") and the year sections. **"Show all N"
  expands inline in place** — semantic sections stay below, nothing navigates — and
  any new submit or filter change resets the strip to capped. The pinned **Best
  match** card renders only when the exact strip is empty — if exact hits exist,
  they are the best match and a second "best" header would lie. Year headers are
  sticky, newest first, and suppressed **only when all results share one year** —
  two results from different years always keep their headers, because for a
  temporally-phrased query ("上个月买的桌布") the year is the only disambiguator on
  the page. All card dates render through the next-intl formatter (zh-Hant:
  2024年5月12日 — never raw MM/DD). When the query contains a recognizable
  relative-date token (last month/上个月/去年/…) and results span years, a one-line
  hint appears: "Search matches descriptions, not dates — dates are shown on each
  result."
- **First-run / empty-query state** (the paradigm is taught here or never): one line —
  "Describe what you remember — what it was bought for, how much it cost, who bought
  it" — plus three tappable example queries (one descriptive, one amount-style, one
  event/person-style) that run on tap. Localized per catalog with translator context;
  the zh examples are idiomatic zh queries, not translations of the English ones.
  For role-holders, a fourth example demonstrates the decided-claims browse. Below
  the examples: **Recent searches** — the last 5, device-local only
  (`localStorage`, with a clear control; never sent to or stored on the server,
  preserving the queries-are-PII posture).
- **Search state survives navigation**: `{query, types, scope, expanded-exact,
  scroll}` persists to `sessionStorage`; returning to `/search` (Back from a result,
  or reopening in the same tab) restores results without re-typing — IME users must
  never pay the composition tax twice for one search session. No query text ever
  enters the URL.
- **Shared devices are a normal church pattern** (family iPad, the office computer):
  both storages are **namespaced by userId and cleared on sign-out** — one member's
  recent queries must never surface for the next person who signs in.
- **No relevance scores in the user UI.** Scores are ordinal, tooltips don't exist on
  touch, and a visible number invites questions it can't answer. Ordering carries the
  signal; exact scores appear only in the admin test box (§10).
- The scope control is one three-segment switch — **"My items / Whole church /
  Claims I decided"** (the third segment only for role-holders; members see no
  control row at all). Selecting "Claims I decided" permits an empty query and shows
  the decided set newest-first, paginated 20 at a time ("Show more" → `cursor`) —
  the browse this scope actually exists for.
- Result cards reuse the app's existing visual language — `card / card-lift /
  pressable` classes and the Claims list's `STATUS_STYLES` chips — not a
  search-only card style.

### 7.3 Result cards are actions, not dead ends

**Receipt cards** — thumbnail (`/file`, or `/preview?page=1` for PDFs — same sources
ReceiptGrid uses), merchant + locale-formatted date, note (one truncated line), owner
(whole-church/decided scopes only), and the state line: status chips when on claims,
an explicit "Not on a claim" chip when not. (`originalName` stays API/exact-match
side; it earns no card line.) Tap behavior is fully defined — the app's lists are
whole-card links and users tap the card, not a 24 px chip:

- **Whole card (primary)**: unclaimed receipt → the "Find in Receipts" action;
  claimed on exactly one claim *that the viewer has a surface for* → that claim's
  surface; on several claims, or when the only claim has no surface for this viewer
  (e.g. a role-holder viewing a foreign receipt whose sole claim is a foreign
  draft) → ReceiptViewer, with that claim's status chip rendered non-interactive
  (same no-`pressable` treatment as the informational claim card).
- **Thumbnail** → ReceiptViewer (zoom/pan) as everywhere else. **Status chips**
  (secondary) → their claim's surface.
- **"Find in Receipts"** deep-links to `/?open=<id>`. **`?open=<id>` is THE app-wide
  deep-link convention this feature mints** (no page reads any such param today, and
  search needs it on three pages — one name, one shared hook, documented in
  CONVENTIONS.md): wait for the list to load → expand the enclosing section if
  needed (the Shoebox's processed `<details>`, an approvals row) → `scrollIntoView`
  → ~3 s `highlight-pulse` ring → strip the param from the URL (back/refresh must
  not re-scroll) → toast if the id is gone ("That receipt is no longer in your
  Receipts"). E2e covers a below-the-fold receipt, not just presence.

**Claim cards** — status pill (existing `Common.status.*` labels), total
(`formatCents`), claimDescription (one truncated line), ministry chips, owner.
Whole-card link target by viewer × claim state (this table exists because the
"obvious" target does not always exist in the app — the approvals inbox has **no
detail view for decided claims** and no per-claim URL today):

| Viewer | Claim state | Card links to |
| :-- | :-- | :-- |
| owner | any | `/claims/[id]` review screen (existing) |
| assigned approver | submitted | `/approvals?open=<id>` — the shared `?open` contract: scroll to the row, expand it (it is expandable today), pulse, strip param |
| assigned approver | decided (approved/rejected/paid) | `/approvals?open=<id>` — scroll + pulse the history row; its existing certificate/packet links are the detail (no new detail view is built for this feature) |
| treasurer/admin | approved/paid | `/finance?open=<id>` — same shared contract on the finance queue |
| role-holder, none of the above (e.g. foreign draft) | any | no link — informational card, visually distinct (no `pressable` affordance) so a non-tappable card doesn't read as broken |

### 7.4 Designing around the 500 ms query embed

The latency budget (~500 ms embed + ~5 ms scoring + hydration) lands at ~600–700 ms —
too slow for search-as-you-type, comfortably fast for explicit search. So:

- **Explicit submit** (Enter or the Search button). No per-keystroke requests — also
  keeps embed load and telemetry proportional to real searches.
- **IME safety (a third of the user base types Chinese)**: Enter is ignored while a
  composition is in progress (`event.isComposing` / `keyCode === 229`) — pinyin/
  zhuyin users pressing Enter to commit 王姐妹 must never fire a search on "wang".
  Covered by a unit test dispatching `KeyboardEvent({key:"Enter", isComposing:true})`
  (CDP IME simulation is flaky; the guard is a pure event-property check). The Search
  button stays full-size on mobile (44 px target) since IME users often prefer
  tapping.
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
- **Freshness is explained in the caller's terms and per kind** (wording matters —
  the two pipelines have different clocks):
  - pending receipts: "2 of your receipts are still being added to search — usually
    ready in about a minute."
  - pending claims (the debounce): "Claims you edited recently appear in search a few
    minutes after you stop editing." (`myNextReadyAt` from the job's `nextAttemptAt`
    lets the UI say "in about N minutes" honestly.)
  Empty result + own pending items → the note is the headline; non-empty + pending →
  a quiet one-liner. While a backfill/rebuild runs, the note falls back to the coarse
  global figure (`rebuildPending`, §6.1): "Search is still indexing older items —
  about n to go."
- Empty state distinguishes two named strings: no-matches — "No matches. Try fewer
  or different words — exact wording was searched too." — vs nothing-indexed —
  "Nothing is searchable yet — your items are still being added." Both are message
  keys like every string here, as are the claims pill's chip variant ("Claims only
  ✕") and the recents clear control ("Clear").

### 7.5 i18n & testids

Every string through `messages/<locale>.json` with translator `context` notes
(the short ones especially: "Whole church", "Claims I decided", "Searching…",
"Not on a claim", the example queries). Localization decisions that must land WITH
the strings, not after:

- **Glossary rows** (`messages/GLOSSARY.md`): *search* = 搜索 (zh-Hans) / 搜尋
  (zh-Hant); *whole church* (scope label) = 全教会 / 全教會; *decide (a claim)* uses
  the approval register with completed aspect — 我审批过的 / 我審批過的 — never 决定
  (wrong register) or bare 我审批的 (reads as "awaiting my approval"); *not on a
  claim* (chip). "Search" appears in ≥4 keys (nav, two pills, button) — declare any
  identical English values in `SAME_VALUE_GROUPS` or the parity test fails.
- **Example queries are hand-authored per locale, not drafted**: write the zh values
  by hand, mark them `"reviewed"` in `translation-state.json` (the pipeline's only
  durable protection against redraft-clobbering), and write each `context` note as
  "write an idiomatic Chinese search query a church member would actually type — do
  NOT translate the English example", so even a `--force` redraft carries the
  intent.
- The relative-date hint's **token detector is per-locale code**, not translated
  copy: the zh token list (上个月/上個月/去年/昨天/…) ships beside the English one. New testids, following the existing
convention: `search-input, search-submit, search-type-chip, search-scope-filter,
search-exact-section, search-exact-show-all, search-best-match, search-group-<year>,
search-result-<kind>-<id>, search-find-in-receipts-<id>, search-example-<n>,
search-recent-<n>, search-recent-clear, search-show-more, search-date-hint,
search-pending-note, search-degraded-note, search-empty, shoebox-search-pill,
claims-search-pill, highlight-pulse` — plus the admin card's
`embedding-settings-form, embedding-test-connection, embedding-save,
embedding-skip-probe, embedding-rebuild, embedding-rebuild-progress,
embedding-retry-job-<id>, embedding-test-query`.

## 8. Failure modes

| Failure | Behavior |
| :-- | :-- |
| Endpoint down during search | exact-match results + outcome-focused degraded banner (§6.2) — never a dead search page |
| Endpoint down during ingest | jobs retry with backoff (§5.3); queue depth visible in admin; search keeps serving the existing index |
| Job fails 8 times | `status="failed"` + `failedSourceSha256`; listed in admin in outcome language (§10); "Retry" re-queues; the sweep re-queues it ONLY if its content later changes — failed is otherwise stable (§5.4). The item remains findable via exact match |
| Claim composite exceeds server context | worker halves the items list and retries once (§3.1) before counting a failure |
| Admin enters a bad endpoint/model/dim | the save-time probe (§3.2) rejects it — misconfiguration cannot reach the worker or the index |
| Admin needs to change config while endpoint is down | disable/queryPrefix never probe; "Save without testing" escape is audited (§3.2) — no lockout |
| Model changed | index wiped + rebuilt (§3.3); exact-match carries search; progress in admin + pending note in UI |
| Endpoint reconfigured out-of-band (dim drift) | provider's dim check errors the job (visible in admin); index unaffected until vectors actually change |
| Edit races a running embed | generation-conditional finalize with the job update FIRST (§5.3) — a stale vector is never persisted; the follow-up job re-embeds |
| Delete races a running embed | finalize re-checks the target in-transaction; sweep GCs any survivor (§5.4) |
| Container crash mid-embed | lease expiry reclaims `running` rows (nextAttemptAt reset to now) |
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
- `model` = the model actually used (`"mock"` under mock), `durationMs`,
  `status`/`errorMessage` as usual. Provider error messages are safe (llama.cpp
  errors carry no input content).
- `userId`: query embeds log the **caller**; background document embeds log the
  **target's owner** (the queue has no acting human — the owner is the tenant the
  work belongs to).
- `kind="embedding"` rows are **excluded from the tuning UI** (`/api/extraction-logs`
  list) — operational, not extraction-quality data — and the daily sweep deletes
  embedding-kind logs older than **90 days**.

This is a deliberate, documented narrowing of invariant 7's "log the prompt" for one
kind: the *call trail* stays complete (who/what/when/how long/outcome); the *content*
is deliberately not retained. Queue mutations themselves are not AuditEvents (no human
action); admin actions **are**: `update-embedding-config` (field diff, API key
redacted, probe-skipped flag), `retry-embedding`, `rebuild-embeddings`.

## 10. Admin surface — outcome language for a volunteer, not operator language

A "Search" card on `/admin` behind the existing `isAppAdmin()` gate (API under
`/api/admin/…`). Its audience is a volunteer church admin, so every element leads
with the outcome and keeps machinery in expandos:

- **Unconfigured (the first thing a new admin sees)**: a "Connect search" panel —
  one sentence on what the feature does, and exactly two fields: endpoint URL and
  API key ("from whoever runs your church's AI server — ask them for these two
  values"). Everything else is derived (dim via the probe) or defaulted (model name,
  prefix, threshold).
- **Backend settings** (§3.2): endpoint; API key (write-only, shows fingerprint);
  **model name labeled with its real meaning** — "identifies this search index —
  changing it rebuilds search from scratch (~N hours at the current corpus size)" —
  the consequence lives in the label, not only a post-hoc warning; dimension shown
  as read-only "Detected: 2048" (manual field only under Save-without-testing);
  query prefix and match threshold (`minScoreMilli`, next to the test box that shows
  scores); enabled toggle; "Test connection".
- **Status line first, counts second**: "Search is up to date" / "N items waiting —
  about X minutes" (queue depth × measured per-item time) / "Rebuilding: n of m,
  about X h left". While any backfill/rebuild runs, one literal-preview line shows
  what the congregation is seeing: *Members currently see: "Search is still indexing
  older items — n to go."* Detailed per-status counts and oldest-queued-age live in
  an expando.
- **Failed items** (§5.4 makes this list stable, not Sisyphean): each row leads with
  outcome language mapped from the known error classes — e.g. "The search server
  couldn't read this receipt's image. It can still be found by its text (exact
  match), just not by description." — with the raw `lastError` in a details expando;
  per-row and bulk Retry.
- **Test query box**: run a search as-admin (admin scope = everything, per the §6.3
  matrix — stated, not implicit) with visible scores — the only place scores render,
  and the natural smoke test after any settings change.
- **Rebuild index**: forced-staleness sweep on the current model — the hammer for
  "the endpoint was silently swapped under me". Kicks the sweep synchronously
  (§3.3) so progress starts moving before the admin's eyes.

## 11. Testing plan

- **Unit** (Vitest, `EMBEDDING_MOCK`): cosine/top-K/threshold/year-grouping/
  best-match-suppression pure functions; exact-match pass (NFKC + full-width
  normalization, tokenized AND, `%`/`_` escaping, money parsing incl. `¥`/`元`/
  full-width digits → cents equality); queue state machine — enqueue-dedupe, backoff
  schedule, lease reclaim (resets `nextAttemptAt`), failed-terminal, **generation
  race** (enqueue during running → finalize's conditional write comes FIRST and skips
  the vector write; deletion during running → no orphan row), **draft debounce**
  (successive mutations push `nextAttemptAt`); composite builder (money formatting,
  CJK content untouched, excluded rows omitted, byte-budget truncation, draft vs
  frozen); receipt fingerprint covers fileSha256/note/merchant/purchaseDate;
  permission matrix as a table test — member/approver/treasurer × scope, asserting
  404s exactly where the matrix says; decided-scope prefetch sets + empty-query
  browse; **model change** — settings swap wipes rows/jobs atomically, sweep
  re-enqueues, mock model salting proves old vectors can't score; probe policy
  (disable never probed; skip-probe audited; probe response carries detected dim);
  **failed-job stability** — sweep skips failed jobs whose fingerprint equals
  `failedSourceSha256`, re-enqueues on content change; **API-key readback** — admin
  GET never contains the stored key (fingerprint + `apiKeySet` only), absent PUT
  field preserves it; IME guard via dispatched
  `KeyboardEvent({key:"Enter", isComposing:true})`.
- **e2e** (chromium; `EMBEDDING_MOCK=1` + shrunk `EMBEDDING_DRAFT_IDLE_MS` wired into
  `tests/e2e/start-server.sh`; determinism via `wakeEmbeddingWorker`, §5.3): upload →
  worker indexes → search finds it; a draft claim becomes searchable after the idle
  window and an edit refreshes its embedding; "Find in Receipts" lands highlighted on
  a below-the-fold receipt (incl. inside the collapsed processed section); Back from
  a result restores query + results from sessionStorage; "Show all N" expands inline
  and resets on the next submit; approver default scope is whole-church and can open
  a foreign receipt image; member `scope:"all"` → 404; decided scope browses with an
  empty query and `?open=<id>` lands on the approvals row; degraded mode via the
  mock's `__EMBED_FAIL__` lever shows exact matches + banner; admin model change →
  rebuild → search works on the new model; security sweep updated for the ratified
  grant.
- **Mock design note**: the unit-test mock must be similarity-meaningful
  (bag-of-tokens folded into the space), not random — tests assert *ranking*, not
  just presence — and must fold CJK bigrams so Chinese fixtures rank for Chinese
  queries.
- **Recorded real embeddings (implemented)**: the e2e server replays REAL vectors
  recorded from the production endpoint (`npm run record:embeddings` →
  `tests/e2e/embedding-fixtures/embeddings.json`; replay server
  `tests/e2e/mock-embedding-server.mjs`). `search-journeys.spec.ts` runs the
  bilingual corpus journeys (en→en, zh→en, en→zh, zh→zh), amount journeys
  (incl. full-width IME input), the zh claim draft→frozen journey, the decided
  browse, and a score-fidelity check asserting the app serves the recorded
  cosines end-to-end (±0.02) — which doubles as a byte-determinism canary for
  the image pipeline. Unknown texts (dynamic composites) project onto recorded
  anchors by token overlap, so they stay in real model geometry. See
  docs/agent/TESTING.md "Recorded real embeddings".

## 12. Endpoint questions — RESOLVED by live probing (§3.1)

Answered 2026-07-16 against the real endpoint (`scripts/probe-embedding-endpoint.mjs`
re-verifies on demand):

1. **Image encoding**: images do NOT go through `/v1/embeddings` (text-only there);
   they go through native `/embeddings` as raw base64 in `multimodal_data` with a
   `<__media__>` token per image — no data-URI. Text+image pairing in one input
   works. Bearer auth on both routes.
2. **Dimension**: 2048, unit-normalized at the source. No MRL truncation offered by
   the server; the full-dim matrix is fine at church scale (§6.4).
3. **Batching**: yes on both routes; worker stays sequential (a 2-item native batch
   took ~2× a single — batching buys queueing simplicity, not GPU time).
4. **Instruction prefix**: confirmed working — `"Instruct: Retrieve the receipt
   matching the query. Query: "` is the `queryPrefix` seed (§3.2; admin-tunable, no
   re-index needed).

New facts the probe surfaced that the design now depends on: **no WebP, no PDF** at
the endpoint (ingest normalizes everything to JPEG), **image size → latency** (≤640 px
inputs, `EMBEDDING_MAX_PX`), and an **8192-token server context** (bounds the claim
composite via a ~4 000-byte budget + shrink-and-retry). To add: zh↔en cross-language
retrieval cases (§3.1) before implementation lands.

## 13. Build order

1. Schema + migration (3 tables + `Receipt.fileSha256`, `connection_limit=1` +
   WAL/busy_timeout); provider (verified contract, §3.1) + mock (with fail lever);
   settings accessor with env seed (+ `EMBEDDING_DEV` gate) + probe policy;
   composite/fingerprint builders; zh probe cases added to
   `scripts/probe-embedding-endpoint.mjs`.
2. **Role-read grant commit** (§6.3): file/preview role gate + ESIGN §6.3 amendment +
   security-sweep exception + tests — authz reviewable in isolation, before search.
3. Worker (`instrumentation.ts` + guards) + triggers + backfill/reconcile/GC sweep.
4. `/api/search`: exact pass (NFKC/tokenized/escaped) + index cache + permission
   matrix + decided-scope prefetch + degraded mode.
5. `/search` UI + entry points (pills, NavBar) + the shared `?open` deep-link hook
   (Shoebox/approvals/finance + CONVENTIONS.md entry) + i18n catalogs
   (en/zh-Hans/zh-Hant) **with the §7.5 glossary rows and hand-authored reviewed
   example queries in the same commit**.
6. Admin card: settings + queue health/rebuild progress + test query box.
7. Docs graduation: new invariants into `CLAUDE.md` / `DATA_MODEL.md`.
