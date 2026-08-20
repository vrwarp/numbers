/**
 * API/page latency measurement against the seeded perf server
 * (scripts/perf/start-server.sh). Signs in as the seeded main user and
 * reports p50/p95/max over N sequential requests per target, plus a
 * small parallel burst on the hottest list endpoint.
 *
 *   node scripts/perf/measure.mjs [baseUrl]     # default http://127.0.0.1:3200
 */
const base = process.argv[2] || "http://127.0.0.1:3200";
const N = Number(process.env.PERF_N || 25);

async function signIn(email, name) {
  const res = await fetch(`${base}/api/auth/test-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  if (!res.ok) throw new Error(`test-login failed: ${res.status}`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: pick(0.5), p95: pick(0.95), max: s[s.length - 1] };
}

async function timeOne(cookie, target) {
  const started = performance.now();
  const res = await fetch(base + target.path, {
    method: target.method || "GET",
    headers: {
      cookie,
      ...(target.body ? { "Content-Type": "application/json" } : {}),
      ...(target.headers || {}),
    },
    body: target.body ? JSON.stringify(target.body) : undefined,
  });
  const buf = await res.arrayBuffer();
  const ms = performance.now() - started;
  if (res.status !== (target.expect ?? 200)) {
    throw new Error(`${target.name}: HTTP ${res.status} (${new TextDecoder().decode(buf).slice(0, 200)})`);
  }
  return { ms, bytes: buf.byteLength };
}

async function main() {
  const cookie = await signIn("perf@example.com", "Perf Main");

  // Discover seeded ids for parameterized routes.
  const receiptsRes = await fetch(`${base}/api/receipts`, { headers: { cookie } });
  const { receipts } = await receiptsRes.json();
  const claimsRes = await fetch(`${base}/api/reimbursements`, { headers: { cookie } });
  const { reimbursements } = await claimsRes.json();
  const draft = reimbursements.find((r) => r.status === "draft");
  const biggest = [...reimbursements].sort(
    (a, b) => (b._count?.lineItems ?? 0) - (a._count?.lineItems ?? 0)
  )[0];
  const imageReceipt = receipts.find((r) => r.mimeType === "image/webp");
  const pdfReceipt = receipts.find((r) => r.mimeType === "application/pdf");
  console.log(`seeded: ${receipts.length} receipts, ${reimbursements.length} claims`);

  const targets = [
    { name: "GET /api/receipts (shoebox list)", path: "/api/receipts" },
    { name: "GET /api/reimbursements (claims list)", path: "/api/reimbursements" },
    { name: `GET /api/reimbursements/[id] (review, big)`, path: `/api/reimbursements/${biggest.id}` },
    ...(draft
      ? [{ name: "GET /api/reimbursements/[id] (draft)", path: `/api/reimbursements/${draft.id}` }]
      : []),
    { name: "GET /api/receipts/[id]/file (webp)", path: `/api/receipts/${imageReceipt.id}/file` },
    ...(pdfReceipt
      ? [{ name: "GET /api/receipts/[id]/preview?page=1", path: `/api/receipts/${pdfReceipt.id}/preview?page=1` }]
      : []),
    { name: "GET /api/extraction-logs", path: "/api/extraction-logs" },
    // /api/approvals 404s until the e-sign registry is bootstrapped — a full
    // ceremony setup is out of scope for this latency snapshot.
    { name: "GET /api/notifications/activity", path: "/api/notifications/activity" },
    {
      name: "POST /api/search (semantic, mine)",
      path: "/api/search",
      method: "POST",
      body: { query: "retreat snacks", scope: "mine" },
    },
    {
      name: "POST /api/search (semantic, all)",
      path: "/api/search",
      method: "POST",
      body: { query: "paper towels costco", scope: "all" },
    },
    { name: "PAGE / (shoebox)", path: "/" },
    { name: "PAGE /claims", path: "/claims" },
    { name: `PAGE /claims/[id] (big)`, path: `/claims/${biggest.id}` },
    { name: "PAGE /search", path: "/search" },
  ];

  const rows = [];
  for (const target of targets) {
    // Warm-up (route compilation, caches) then measure.
    for (let i = 0; i < 3; i++) await timeOne(cookie, target);
    const samples = [];
    let bytes = 0;
    for (let i = 0; i < N; i++) {
      const r = await timeOne(cookie, target);
      samples.push(r.ms);
      bytes = r.bytes;
    }
    const { p50, p95, max } = stats(samples);
    rows.push({ name: target.name, p50, p95, max, kb: bytes / 1024 });
  }

  // Parallel burst: the shoebox list under 8-way concurrency (page load fans
  // out list + thumbnails; SQLite is single-writer but reads should overlap).
  {
    const burst = [];
    for (let round = 0; round < 5; round++) {
      const started = performance.now();
      await Promise.all(
        Array.from({ length: 8 }, () => timeOne(cookie, { name: "burst", path: "/api/receipts" }))
      );
      burst.push(performance.now() - started);
    }
    const { p50, p95, max } = stats(burst);
    rows.push({ name: "8× parallel GET /api/receipts (wall)", p50, p95, max, kb: 0 });
  }

  const width = Math.max(...rows.map((r) => r.name.length));
  console.log(`\n${"target".padEnd(width)}  ${"p50".padStart(7)}  ${"p95".padStart(7)}  ${"max".padStart(7)}  ${"size".padStart(8)}`);
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(width)}  ${r.p50.toFixed(1).padStart(5)}ms  ${r.p95.toFixed(1).padStart(5)}ms  ${r.max.toFixed(1).padStart(5)}ms  ${r.kb ? (r.kb.toFixed(0) + "KB").padStart(8) : "".padStart(8)}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
