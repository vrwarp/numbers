// Probe the semantic-search embedding endpoint (docs/SEARCH_DESIGN.md §3.1) and
// verify it behaves the way the design assumes. Run manually — needs network and
// a key, so it is NOT part of npm test:
//
//   EMBEDDING_ENDPOINT=https://… EMBEDDING_API_KEY=sk-… \
//     node scripts/probe-embedding-endpoint.mjs
//
// Generates its own fixtures (two synthetic receipts via sharp + a one-page PDF
// via pdf-lib), exercises both routes, and exits non-zero if any HARD expectation
// fails. INFO lines document capabilities the app must not rely on (they may
// change with a server upgrade — e.g. WebP starting to work).
//
// Verified against llama.cpp serving qwen3-vl-embedding-2b (2026-07): dim 2048,
// unit-normalized, /v1/embeddings is text-only, native /embeddings takes
// prompt_string + raw-base64 multimodal_data (PNG/JPEG/GIF; no WebP, no PDF,
// no data-URI), text and image vectors share one space.
import sharp from "sharp";
import { PDFDocument, StandardFonts } from "pdf-lib";

const BASE = (process.env.EMBEDDING_ENDPOINT ?? "").replace(/\/+$/, "");
const KEY = process.env.EMBEDDING_API_KEY ?? "";
const MODEL = process.env.EMBEDDING_MODEL || "qwen3-vl-embedding-2b";
const QUERY_PREFIX = "Instruct: Retrieve the receipt matching the query. Query: ";
if (!BASE) {
  console.error("Set EMBEDDING_ENDPOINT (and usually EMBEDDING_API_KEY).");
  process.exit(2);
}

let failures = 0;
const pass = (name, extra = "") => console.log(`PASS  ${name}${extra ? `  (${extra})` : ""}`);
const fail = (name, why) => (failures++, console.error(`FAIL  ${name}  — ${why}`));
const info = (name, note) => console.log(`INFO  ${name}  — ${note}`);
const expect = (name, cond, why, extra) => (cond ? pass(name, extra) : fail(name, why));

async function call(path, body) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ms, json, snippet: text.replace(/\s+/g, " ").slice(0, 160) };
}
// Both response shapes: native → [{index, embedding}], /v1 → {data:[{embedding}]}
const vecs = (j) =>
  Array.isArray(j)
    ? j.map((r) => (Array.isArray(r.embedding?.[0]) ? r.embedding[0] : r.embedding))
    : j?.data?.map((d) => d.embedding);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const norm = (v) => Math.sqrt(dot(v, v));
const nativeBody = (prompt, images = []) => ({
  content: [{ prompt_string: prompt, multimodal_data: images.map((b) => b.toString("base64")) }],
});

// ---- fixtures: two visually-distinct synthetic receipts + a PDF ----------------
const receiptSvg = (lines) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640">
  <rect width="480" height="640" fill="white"/>
  ${lines.map((l, i) => `<text x="30" y="${70 + i * 44}" font-family="monospace" font-size="26" fill="black">${l}</text>`).join("")}
  </svg>`);
const starbucksSvg = receiptSvg([
  "STARBUCKS STORE #1234", "123 MAIN ST", "------------------------",
  "GRANDE LATTE      $4.50", "BLUEBERRY MUFFIN  $3.25", "------------------------",
  "TOTAL             $7.75", "VISA ****1234", "2026-05-12  08:14",
]);
const homedepotSvg = receiptSvg([
  "THE HOME DEPOT", "STORE 0482", "------------------------",
  "2X4 LUMBER 8FT x6 $45.30", "DECK SCREWS 5LB  $12.99", "------------------------",
  "TOTAL            $67.26", "2026-05-14  16:42",
]);
const sbJpg = await sharp(starbucksSvg).jpeg({ quality: 85 }).toBuffer();
const sbPng = await sharp(starbucksSvg).png().toBuffer();
const sbWebp = await sharp(starbucksSvg).webp({ quality: 80 }).toBuffer();
const hdJpg = await sharp(homedepotSvg).jpeg({ quality: 85 }).toBuffer();
const pdfDoc = await PDFDocument.create();
const page = pdfDoc.addPage([480, 640]);
const font = await pdfDoc.embedFont(StandardFonts.Courier);
["STARBUCKS STORE #1234", "GRANDE LATTE $4.50", "TOTAL $7.75"].forEach((l, i) =>
  page.drawText(l, { x: 30, y: 580 - i * 40, size: 20, font }));
const sbPdf = Buffer.from(await pdfDoc.save());

// ---- 1. OpenAI-compatible text route -------------------------------------------
const single = await call("/v1/embeddings", { model: MODEL, input: QUERY_PREFIX + "coffee at Starbucks" });
const singleV = vecs(single.json)?.[0];
expect("/v1 text embed", single.status === 200 && !!singleV, `status ${single.status}: ${single.snippet}`, `${single.ms}ms`);
if (!singleV) process.exit(1); // nothing else is meaningful
const DIM = singleV.length;
console.log(`      model=${MODEL} dim=${DIM}`);
expect("/v1 vectors are unit-normalized", Math.abs(norm(singleV) - 1) < 1e-3, `norm=${norm(singleV)}`);

const batch = await call("/v1/embeddings", {
  model: MODEL,
  input: [QUERY_PREFIX + "coffee at Starbucks", QUERY_PREFIX + "lumber and screws from the hardware store"],
});
const batchV = vecs(batch.json);
expect("/v1 batch input (array of strings)", batch.status === 200 && batchV?.length === 2, `status ${batch.status}: ${batch.snippet}`, `${batch.ms}ms`);
const [qCoffee, qLumber] = batchV ?? [singleV, null];

// ---- 2. Native multimodal route -------------------------------------------------
const run = async (name, prompt, images, { hard = true } = {}) => {
  const r = await call("/embeddings", nativeBody(prompt, images));
  const v = r.status === 200 ? vecs(r.json)?.[0] : null;
  if (hard) expect(name, !!v && v.length === DIM, `status ${r.status}: ${r.snippet}`, `${r.ms}ms`);
  else info(name, v ? `SUPPORTED (${r.ms}ms)` : `unsupported — status ${r.status}: ${r.snippet}`);
  return v;
};
const iSb = await run("native JPEG image embed", "<__media__>", [sbJpg]);
const iHd = await run("native JPEG image embed (2nd receipt)", "<__media__>", [hdJpg]);
const iPng = await run("native PNG image embed", "<__media__>", [sbPng]);
const iPair = await run("native text+image pairing", "A photographed purchase receipt. User note: morning coffee run. <__media__>", [sbJpg]);
const tNative = await run("native text-only embed", QUERY_PREFIX + "coffee at Starbucks", []);

// Capability probes the app must NOT rely on (transcode/rasterize instead):
await run("WebP via native route", "<__media__>", [sbWebp], { hard: false });
await run("PDF bytes via native route", "<__media__>", [sbPdf], { hard: false });
const dataUri = await call("/embeddings", {
  content: [{ prompt_string: "<__media__>", multimodal_data: ["data:image/png;base64," + sbPng.toString("base64")] }],
});
info("data-URI prefix via native route", dataUri.status === 200 ? "SUPPORTED" : `unsupported — raw base64 only (status ${dataUri.status})`);

const nBatch = await call("/embeddings", {
  content: [
    { prompt_string: "<__media__>", multimodal_data: [sbJpg.toString("base64")] },
    { prompt_string: "<__media__>", multimodal_data: [hdJpg.toString("base64")] },
  ],
});
const nBatchV = vecs(nBatch.json);
expect("native batch (2 content items)", nBatch.status === 200 && nBatchV?.length === 2, `status ${nBatch.status}: ${nBatch.snippet}`, `${nBatch.ms}ms`);

// ---- 3. The properties search actually depends on ------------------------------
if (iSb && iHd && qCoffee && qLumber) {
  const cs = dot(qCoffee, iSb), ch = dot(qCoffee, iHd);
  const ls = dot(qLumber, iSb), lh = dot(qLumber, iHd);
  console.log(`      coffee→sb ${cs.toFixed(3)} coffee→hd ${ch.toFixed(3)} | lumber→sb ${ls.toFixed(3)} lumber→hd ${lh.toFixed(3)}`);
  expect("cross-modal ranking: coffee query prefers coffee receipt", cs > ch + 0.05, `${cs.toFixed(3)} vs ${ch.toFixed(3)}`);
  expect("cross-modal ranking: hardware query prefers hardware receipt", lh > ls + 0.05, `${lh.toFixed(3)} vs ${ls.toFixed(3)}`);
}
if (iSb && iPng) expect("PNG and JPEG of one receipt agree", dot(iSb, iPng) > 0.95, `cos=${dot(iSb, iPng).toFixed(3)}`);
if (tNative && qCoffee) expect("native text == /v1 text (same space)", dot(tNative, qCoffee) > 0.999, `cos=${dot(tNative, qCoffee).toFixed(4)}`);
if (iPair && iSb && qCoffee) info("pairing effect", `note-aware query→paired cos=${dot(qCoffee, iPair).toFixed(3)} vs image-only ${dot(qCoffee, iSb).toFixed(3)}`);

console.log(failures ? `\n${failures} hard expectation(s) FAILED` : "\nAll hard expectations passed.");
process.exit(failures ? 1 : 0);
