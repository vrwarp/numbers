# Performance instrumentation

Measurement harness for the app's hot paths. Everything here runs against a
**seeded throwaway deployment** in `.perf-data/` (gitignored) — never your dev
or production database.

## Start the seeded server

```bash
npm run perf:server            # builds if needed, seeds, serves on :3200
PERF_RESET=1 npm run perf:server      # wipe .perf-data and re-seed
PERF_FORCE_BUILD=1 npm run perf:server  # force `next build` after code changes
```

The seed (`seed.ts`) writes a church deployment after ~2 years of heavy use:
**320 receipts for one power user** (12 of them PDFs, all pre-annotated so claim
creation exercises the no-AI-call path) plus 5 background tenants × 60 receipts,
20 draft claims, 24 frozen claims across every status, with the audit and
`ExtractionLog` trail those would carry. Runs with `AI_MOCK`, `PUSH_MOCK`,
`EMBEDDING_MOCK`, and the annotation drip parked, so measurements see steady
request cost and not a provider call racing the benchmark.

⚠ `next start` serves the `.next` build on disk. After changing app code,
rebuild AND restart, or you will measure the old bundle (a stale server
holding :3200 silently serves pre-rebuild chunks — the symptom is a
`ChunkLoadError` in the browser).

## Measure

| Command | Answers |
| :-- | :-- |
| `npm run perf:api` | p50/p95/max per API route and per page render, plus an 8-way parallel burst on the shoebox list |
| `npm run perf:mutations` | the write paths: upload (sharp compression), claim creation, row PATCH, verify-all, **PDF generation**, revert, delete |
| `npm run perf:client` | TTFB/FCP/LCP, CLS, long tasks + TBT, scroll jank and interaction latency on Receipts / claims / review / search — 4× CPU throttle, phone viewport |
| `npm run perf:scroll` | scroll jank alone, at two velocities: a realistic `fling` and the `stress` fling-to-bottom |
| `npm run perf:network` | how many receipt-image requests the wall actually issues at first paint vs after a full scroll |
| `npm run perf:explain` | `EXPLAIN QUERY PLAN` + timing for the hot queries against the seeded db — flags full-table scans |
| `npm run perf:indexes` | builds a **decade-scale** db (50k receipts / 5k claims / 150k logs / 60k audit rows) and times the hot queries with and without candidate indexes, printing a KEEP / no-gain verdict per index |
| `npm run perf:shot` | screenshots the wall at phone + desktop widths, plain / selected / filtered, into `screenshots/perf/` — a layout change should be looked at, not only asserted |

The client scripts need Chromium; in a sandbox pass the pre-installed one:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run perf:client
```

## Reference numbers

Measured on this harness (seed scale; phone profile = Pixel-ish viewport at
4× CPU throttle). Use them as regression tripwires, not absolutes — they are
machine-specific.

**Server** (p50 / p95): shoebox list 13 / 18 ms · claims list 6 / 8 ms · review
claim GET 6 / 12 ms · receipt file 5 / 6 ms · search 12 / 15 ms · page renders
27–50 ms. Writes: upload 168 ms (sharp), claim create from 10 annotated
receipts 10 ms, row PATCH 10 ms, **PDF generation 313 / 426 ms**, revert 16 ms.

**Client, Receipts wall at 320 cards** (4× throttle): 12 image requests at first
paint (lazy loading working), LCP ~1.2 s, CLS ~0.0002. Realistic fling: **7%
dropped frames, p95 frame 50 ms**; warm (images cached) **0.9%, p95 33 ms**.

`index-scale` verdict, at decade scale: of ~13 candidate indexes only
`AuditEvent(action)` earns one (12.4 ms → 0.28 ms, 44×); every other hot query
is already ≤3 ms and gains ≤1.4×. Re-run it before adding an index — indexes
cost write throughput, and this says which ones pay for themselves.
