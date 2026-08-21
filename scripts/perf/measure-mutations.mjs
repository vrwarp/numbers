/**
 * Mutation-path latency measurement against the seeded perf server: upload
 * (sharp compression), claim creation from stored annotations, row edits,
 * verify-all, PDF generation (the heaviest op), revert, delete. Uses its own
 * throwaway receipts/claims and cleans up after itself.
 *
 *   node scripts/perf/measure-mutations.mjs [baseUrl]
 */
import sharp from "sharp";
const base = process.argv[2] || "http://127.0.0.1:3200";

async function signIn(email, name) {
  const res = await fetch(`${base}/api/auth/test-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: pick(0.5), p95: pick(0.95), max: s[s.length - 1] };
}

async function call(cookie, path, init = {}, expect = 200) {
  const started = performance.now();
  const res = await fetch(base + path, { ...init, headers: { cookie, ...(init.headers || {}) } });
  const body = await res.arrayBuffer();
  const ms = performance.now() - started;
  if (res.status !== expect) {
    throw new Error(`${path}: HTTP ${res.status} ${new TextDecoder().decode(body).slice(0, 300)}`);
  }
  return { ms, body, res };
}

/** A realistic phone-photo receipt: 1600px tall JPEG like the client uploads. */
async function makePhoto(px) {
  const w = Math.round(px * 0.75);
  const rows = Array.from({ length: 30 }, (_, i) =>
    `<text x="40" y="${140 + i * 46}" font-family="monospace" font-size="30" fill="#1a1a1a">ITEM ${i} PAPER GOODS         ${(i * 3.17).toFixed(2)}</text>`
  ).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${px}">
    <rect width="${w}" height="${px}" fill="#f8f7f2"/>${rows}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

async function measure(name, n, fn) {
  const samples = [];
  let out;
  for (let i = 0; i < n; i++) {
    const r = await fn(i);
    samples.push(r.ms);
    out = r;
  }
  const { p50, p95, max } = stats(samples);
  console.log(
    `${name.padEnd(48)}  ${p50.toFixed(1).padStart(6)}ms  ${p95.toFixed(1).padStart(6)}ms  ${max.toFixed(1).padStart(6)}ms`
  );
  return out;
}

async function main() {
  const cookie = await signIn("perf@example.com", "Perf Main");
  console.log(`${"mutation".padEnd(48)}  ${"p50".padStart(8)}  ${"p95".padStart(8)}  ${"max".padStart(8)}`);

  // 1) Upload: server-side compressReceiptImage on a client-downscaled 1600px
  //    photo, and on an oversized 4000px original (user bypassing the client).
  const photo1600 = await makePhoto(1600);
  const photo4000 = await makePhoto(4000);
  const uploadedIds = [];
  const upload = (bytes, name) => async () => {
    const form = new FormData();
    form.append("files", new Blob([bytes], { type: "image/jpeg" }), name);
    const started = performance.now();
    const res = await fetch(`${base}/api/receipts`, { method: "POST", headers: { cookie }, body: form });
    const json = await res.json();
    if (res.status !== 201) throw new Error(`upload: ${res.status} ${JSON.stringify(json)}`);
    uploadedIds.push(json.receipts[0].id);
    return { ms: performance.now() - started, id: json.receipts[0].id };
  };
  await measure(`POST /api/receipts (1600px, ${(photo1600.length / 1024).toFixed(0)}KB jpeg)`, 8, upload(photo1600, "perf-upload.jpg"));
  await measure(`POST /api/receipts (4000px, ${(photo4000.length / 1024).toFixed(0)}KB jpeg)`, 4, upload(photo4000, "perf-upload-big.jpg"));

  // 2) Claim creation from 10 ALREADY-ANNOTATED receipts (the normal path —
  //    zero AI calls) — then row edit, verify-all, PDF, revert, delete.
  const receiptsJson = JSON.parse(
    new TextDecoder().decode((await call(cookie, "/api/receipts")).body)
  );
  const annotated = receiptsJson.receipts
    .filter((r) => r.annotation === "ready" && r.mimeType === "image/webp")
    .slice(0, 10)
    .map((r) => r.id);

  let claimId;
  await measure("POST /api/reimbursements (10 annotated, no AI)", 6, async () => {
    const r = await call(
      cookie,
      "/api/reimbursements",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptIds: annotated }),
      },
      201
    );
    const { reimbursement } = JSON.parse(new TextDecoder().decode(r.body));
    if (claimId) await call(cookie, `/api/reimbursements/${claimId}`, { method: "DELETE" });
    claimId = reimbursement.id;
    return r;
  });

  const claim = JSON.parse(
    new TextDecoder().decode((await call(cookie, `/api/reimbursements/${claimId}`)).body)
  ).reimbursement;

  await measure("PATCH /api/line-items/[id] (ministry+amount)", 10, (i) =>
    call(cookie, `/api/line-items/${claim.lineItems[i % claim.lineItems.length].id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ministry: "245 Drinking Water", amountCents: 1000 + i }),
    })
  );

  await measure("POST /api/reimbursements/[id]/verify-all", 1, () =>
    call(cookie, `/api/reimbursements/${claimId}/verify-all`, { method: "POST" })
  );

  await measure("POST /api/reimbursements/[id]/pdf (10 receipts)", 5, () =>
    call(cookie, `/api/reimbursements/${claimId}/pdf`, { method: "POST" })
  );

  await measure("POST /api/reimbursements/[id]/revert", 1, () =>
    call(cookie, `/api/reimbursements/${claimId}/revert`, { method: "POST" })
  );

  await measure("DELETE /api/reimbursements/[id]", 1, () =>
    call(cookie, `/api/reimbursements/${claimId}`, { method: "DELETE" })
  );

  // Cleanup the uploaded throwaway receipts.
  for (const id of uploadedIds) {
    await call(cookie, `/api/receipts/${id}`, { method: "DELETE" });
  }
  console.log("cleaned up");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
