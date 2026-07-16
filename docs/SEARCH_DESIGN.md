# Semantic search across receipts and claims — design

Status: **proposed** (embedding endpoint contract pending — see §12 Open questions).
Companion to `docs/ESIGN_DESIGN.md` (this feature amends its §6.3 read-grant list) and
`docs/agent/DATA_MODEL.md` (two new tables).

## 1. Goal

Let users find receipts and claims by meaning, not exact text: "the projector we bought
for VBS", "that Costco run with the returned chairs", "王姐妹's retreat snacks".

- **Members** search their own receipts and their own claims.
- **Approvers** search **all** receipts and **all** claims, with a filter for
  "claims I decided" (approved or rejected by them).
- **Treasurers** (and admins) search **all** receipts and **all** claims.
- Results are ranked by cosine similarity of a Qwen multimodal embedding and presented
  **grouped by year**, best match first within each year.

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
- Draft claims are not semantically indexed (§5.2 explains why); receipts on them are.

## 3. Embedding backend

A self-hosted Qwen multimodal embedding endpoint (details TBD). The integration is
isolated behind one module so the final contract only touches one file:

```
src/lib/embeddings/provider.ts     embedText(text) / embedImage(bytes, mime, text?)
                                   → Float32Array(EMBEDDING_DIM), L2-normalized
src/lib/embeddings/mock.ts         EMBEDDING_MOCK=1 — deterministic hash-based vectors
                                   (token-bag folded into the vector space so that
                                   "costco" query ≈ costco fixture; no network)
```

Config (all via `configValue()`, so `<DATA_DIR>/config.json` can override env):

| Var | Notes |
| :-- | :-- |
| `EMBEDDING_ENDPOINT` | base URL of the Qwen endpoint; **feature is OFF when unset** (no nav entry, routes 404, worker idle) |
| `EMBEDDING_API_KEY` | optional bearer token |
| `EMBEDDING_MODEL` | model id string, stored on every vector row (see §4) |
| `EMBEDDING_DIM` | vector dimension; vectors are L2-normalized at write time so cosine = dot product |
| `EMBEDDING_TIMEOUT_MS` | default 30000 — a 10 s call needs headroom, not minutes |
| `EMBEDDING_MOCK=1` | deterministic vectors, no network (tests/dev, like `AI_MOCK`) |

Normalization rule: **provider.ts always returns unit vectors**. Everything downstream
(storage, scoring) assumes it; cosine similarity becomes a plain dot product.

## 4. Data model

Two new tables (append to `prisma/schema.prisma`; migration committed as usual).
Vectors live in their own table, not columns on Receipt/Reimbursement, so a model/dim
change is a re-embed sweep rather than a schema surgery, and so the join-free scan the
search path does (§6.3) stays cheap.

```prisma
// One vector per indexed document. targetId is a Receipt.id or Reimbursement.id
// (plain string, no FK — rows are deleted by the ingest code alongside their
// target, and the queue must be able to reference not-yet-indexed targets).
model Embedding {
  id           String   @id @default(cuid())
  kind         String   // "receipt" | "claim"
  targetId     String
  // Denormalized owner + year, so the search path scans ONE table with no joins
  // and applies tenant scoping before any vector math.
  userId       String
  year         Int      // grouping key (see §6.4 for how it is derived)
  model        String   // EMBEDDING_MODEL that produced the vector
  dim          Int
  vector       Bytes    // Float32Array little-endian, L2-normalized, length == dim
  // Fingerprint of the exact bytes/text that were embedded — staleness detector.
  // Receipts: sha256 of the stored image file. Claims: packetSha256.
  sourceSha256 String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([kind, targetId])
  @@index([userId])
}

// Durable work queue. One live row per (kind, targetId); re-triggering an
// already-queued item updates it in place rather than growing the queue.
model EmbeddingJob {
  id            String    @id @default(cuid())
  kind          String    // "receipt" | "claim"
  targetId      String
  status        String    @default("queued") // queued | running | done | failed
  // 0 = live event (new upload / new packet), 1 = backfill. The worker drains
  // priority 0 first so fresh items don't wait behind a 3-hour backfill.
  priority      Int       @default(0)
  attempts      Int       @default(0)
  nextAttemptAt DateTime  @default(now())
  // Crash-safety lease: a "running" row whose lease has expired is reclaimable.
  leaseExpiresAt DateTime?
  lastError     String    @default("")
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@unique([kind, targetId])
  @@index([status, priority, nextAttemptAt])
}
```

Deletion: the receipt DELETE route and claim DELETE route also delete the matching
`Embedding` + `EmbeddingJob` rows (no FK cascade — do it in the route transaction).

## 5. Ingest pipeline (the 10 s path)

### 5.1 What gets embedded

**Receipts — the stored image.** Input to `embedImage()` is the already-compressed
stored file (`filePath`, ~100 KB WebP — plenty for an embedding; never the original).
If the endpoint accepts an optional text pairing, send the user's `note` +
extracted `merchant` alongside the pixels. PDF receipts embed their **page-1 raster**,
reusing the existing preview machinery (`src/lib/pdf/preview.ts` cache; generate on
demand if not yet cached).

**Claims — the generated packet, represented as text + first receipt image.**
The naïve reading of "embed the claim PDF" — rasterize the form page — would be a
mistake: every form page is 90% identical AcroForm boilerplate, so all claims would
cluster together and similarity would be dominated by the template, not the content.
Instead the claim's embedding input is a **structured text composite** of exactly what
the packet contains, optionally paired with the first receipt image if the endpoint
supports text+image inputs:

```
Reimbursement claim by <fullName>. <claimDescription>.
Ministries: <distinct formatMinistryEvent values>.
Items: <description> ($<amount>); <description> ($<amount>); …
Merchants: <distinct receipt merchants>. Total $<total>. <MM/YYYY>.
```

(Amounts formatted at this boundary via `src/lib/money.ts`, like the LLM boundary.)
`sourceSha256` for a claim is the `packetSha256` — the composite is derived from the
same frozen content, so the packet hash is the correct staleness key.

### 5.2 Triggers (event-driven — items embed "as soon as available")

| Event | Action |
| :-- | :-- |
| Receipt uploaded (`POST /api/receipts`) | enqueue `{kind:"receipt"}`, priority 0 |
| Receipt image edited / restored (`/api/receipts/[id]/edit`) | re-enqueue (file bytes changed ⇒ `sourceSha256` stale) |
| Claim PDF generated (`POST …/pdf`) and e-sign packet archived | enqueue `{kind:"claim"}`, priority 0; regeneration re-enqueues (new `packetSha256`) |
| Claim reverted to draft | delete the claim's `Embedding`/job — drafts are not indexed |
| Receipt / claim deleted | delete `Embedding` + job |

Drafts are deliberately not indexed: their content churns with every row edit (each
would be a 10 s re-embed), they have no packet to fingerprint, and they are few, recent,
and easy to find on the Claims screen. A claim becomes searchable when it freezes —
which is also the moment its content stops moving. (Receipts, by contrast, are indexed
from upload, so the *material* of a draft is still findable.)

"Enqueue" = upsert on `(kind, targetId)`: reset `status="queued"`, `attempts=0`,
`nextAttemptAt=now`, keep/raise priority. Never blocks or fails the calling route —
queue write errors are logged and swallowed (search is a secondary index, the upload
must not fail because of it).

### 5.3 The worker

A singleton loop inside the app process (registered from `instrumentation.ts`, guarded
by a `globalThis` handle exactly like the Prisma client so dev hot-reload doesn't fork
it). No cron, no child process.

```
loop:
  reclaim: running jobs with leaseExpiresAt < now → back to queued   (crash recovery)
  job = first queued with nextAttemptAt <= now, ORDER BY priority, createdAt
  if none → sleep POLL_MS (default 15 s; an enqueue also pings the loop to wake early)
  mark running, leaseExpiresAt = now + 5 min
  build input (§5.1) → provider call (~10 s) → verify dim → normalize
  upsert Embedding row (+ write ExtractionLog kind="embedding", §9)
  mark done; bump the in-memory index version (§6.3)
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

### 5.4 Backfill

On worker start (and once a day thereafter) a sweep enqueues, at **priority 1**, every
receipt and every FROZEN claim that either has no `Embedding` row or whose
`sourceSha256` / `model` no longer matches (covers: pre-feature rows, rows that missed
a trigger, and an `EMBEDDING_MODEL` change — which naturally becomes a full re-index).
The sweep is a single indexed query pair + upserts; it is idempotent and cheap. At 10 s
per item a 1,000-receipt history backfills in ~3 h of quiet background work while new
uploads still jump the line at priority 0.

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
2. Embed the query — the ~500 ms provider call — through a small **server-side LRU**
   keyed on `(model, normalized query)` (~200 entries, 15 min TTL): repeated searches,
   back-navigation, and filter tweaks skip the wait entirely. Filter changes never
   re-embed (the vector doesn't depend on filters).
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

Duty pauses (`approvalsPaused`/`financePaused`) do **not** narrow search: pauses are
workflow routing, not access revocation (same posture as keeping already-assigned
claims decidable). Role loss does narrow it — the mirror is re-read on every request.

**This is a new cross-tenant read grant.** ESIGN_DESIGN §6.3 currently enumerates
approver-inbox / finance-queue / packet / certificate / reconcile / `/v/<token>` as the
only non-owner reads. Shipping this feature amends that list with:

> *Search read (role-gated): holders of a verified approver/treasurer/admin role may
> read search summaries and receipt files across all tenants.*

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
whole `Embedding` table decoded into one `Float32Array` matrix + a parallel metadata
array `{kind, targetId, userId, year}`. Invalidation is a version counter bumped by the
worker/delete paths; the search path reloads lazily when the version moved. Vectors are
unit-length (§3), so scoring one query is a dot product per row — at 5,000 items ×
1,024 dims that's ~5 M multiply-adds, well under a millisecond; memory ~20 MB.
(If a deployment ever outgrows this, the escape hatch is swapping this one module for
sqlite-vec — nothing else changes.)

### 6.4 Year grouping

The year is **denormalized onto the Embedding row at write time** (`year` column) so
grouping needs no joins:

- **Receipt**: `purchaseDate` prefix (`YYYY` of the transcription string) when it looks
  like a date; else `createdAt` year. This is a substring read of a transcription for
  display bucketing — not date arithmetic (invariant respected).
- **Claim**: `submittedAt ?? createdAt` year.

Ingest recomputes it on every (re-)embed; a re-extraction that changes `purchaseDate`
also re-triggers via the image-edit path or is corrected by the daily sweep.

## 7. UI design

### 7.1 Placement

A dedicated **`/search`** page plus a search entry in the NavBar (magnifier button;
`Cmd/Ctrl-K` shortcut). Server component does the usual `currentUserId()` redirect and
passes the caller's role capabilities (may use scope-all? may use decidedByMe?) so the
client renders only the filters this user is allowed to touch. The nav entry renders
only when the feature is configured (`EMBEDDING_ENDPOINT` set).

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
search-pending-note, search-empty`.

## 8. Failure modes

| Failure | Behavior |
| :-- | :-- |
| Endpoint down during search | 502 with code `search.embedUnavailable` (translated client-side); results panel keeps prior state |
| Endpoint down during ingest | jobs retry with backoff (§5.3); queue depth visible in admin; search keeps serving the existing index |
| Job fails 8 times | `status="failed"`, listed in admin with `lastError`; "Retry" re-queues; a later daily sweep also re-queues it (sha mismatch persists) |
| Dim mismatch (endpoint reconfigured) | provider rejects the vector, job errors (visible), search index ignores rows whose `model` ≠ current `EMBEDDING_MODEL`; fix = daily sweep re-embeds everything |
| Container crash mid-embed | lease expiry reclaims the `running` row (§5.3) |
| Feature unconfigured | no nav entry, `/search` and `/api/search` 404, worker never starts — zero footprint |

## 9. Telemetry (invariant 7)

Every embedding provider call — document ingest **and** query, success **and**
failure — writes an `ExtractionLog` with `kind="embedding"`:
`prompt` = the composite text / query text (images referenced by metadata only, as with
`kind="receipt"` — never bytes), `model` = `EMBEDDING_MODEL` (or `"mock"`),
`parsedJson` = `{dim, targetKind?, targetId?, score_stats?}` — **never the vector**
(it's opaque bulk, and rawResponse stays null for the same reason), `durationMs`,
`status`/`errorMessage`. Queue mutations themselves are not AuditEvents (no human
action, no claim content change); manual admin retry of a failed job **is** audited
(`action="retry-embedding"`).

## 10. Admin surface

A small "Search index" card on `/admin`: counts by job status, oldest queued age,
failed-job list with `lastError` + per-row and bulk Retry, and a "Rebuild index"
button (bumps a re-embed sweep). Read endpoints live under `/api/admin/…` behind the
existing `isAppAdmin()` gate.

## 11. Testing plan

- **Unit** (Vitest, `EMBEDDING_MOCK`): cosine/top-K/threshold/year-grouping pure
  functions; queue state machine (enqueue-dedupe, backoff schedule, lease reclaim,
  failed-terminal); claim composite builder (money formatting, CJK content untouched);
  permission matrix as a table test — member/approver/treasurer × scope × filter,
  asserting 404s exactly where the matrix says.
- **e2e** (chromium, mock embeddings): upload → worker indexes → search finds it;
  approver searches another member's receipt and can open the image; member with
  `scope:"all"` gets 404; "Decided by me" returns only decided claims; security sweep
  updated for the new deliberate grant.
- **Mock design note**: the mock must be similarity-meaningful (bag-of-tokens folded
  into the space), not random — e2e asserts *ranking*, not just presence.

## 12. Open questions (blocked on the endpoint contract)

1. **API shape**: request/response schema, auth, and whether text+image can be embedded
   as ONE input (affects §5.1 pairing) — or images and text land in a shared space via
   separate calls (Qwen3-VL-style unified space assumed).
2. **Dimension & truncation**: native dim? MRL-truncatable (store 1024 instead of 4096
   → 4× smaller matrix)?
3. **Batching**: can the endpoint take a batch? (Worker stays sequential either way,
   but backfill could batch 4–8 images per call if supported.)
4. **Instruction prefixes**: Qwen embedding models score better with an instruction on
   the *query* side ("Represent this church reimbursement search query…") — confirm and
   pin the exact strings, since changing them later invalidates nothing structurally
   but shifts scores (worth a re-embed? decide then).

## 13. Build order

1. Schema + migration; provider + mock; ingest module with composite builder.
2. Worker + triggers + backfill sweep (behind `EMBEDDING_ENDPOINT` config gate).
3. `/api/search` + index cache + permission matrix (+ file/preview role gate + §6.3
   amendment + security-sweep update in the same PR).
4. `/search` UI + NavBar entry + i18n catalogs.
5. Admin card. 6. Docs graduation: new invariants into `CLAUDE.md` / `DATA_MODEL.md`.
