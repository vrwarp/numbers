/**
 * Record REAL embedding vectors for the e2e replay server
 * (tests/e2e/mock-embedding-server.mjs; design: docs/SEARCH_DESIGN.md §11).
 *
 *   EMBEDDING_ENDPOINT=https://… EMBEDDING_API_KEY=sk-… \
 *     npm run record:embeddings [-- --render]
 *
 * - `--render` re-rasterizes the receipt images from the manifest's HTML via
 *   Playwright Chromium (reliable CJK); otherwise the committed PNGs are used.
 * - Every image is pushed through the app's OWN pipeline (compressReceiptImage
 *   → normalizeImageForEmbedding) so the sha the replay server matches on is
 *   exactly what the worker will send at test time.
 * - Output: tests/e2e/embedding-fixtures/embeddings.json — model, dim, the
 *   verbatim vectors (base64 float32), and an expected query×document cosine
 *   matrix the journeys assert against (real scores, not synthetic).
 *
 * Point it at ANY OpenAI-compatible+native llama.cpp endpoint to refresh the
 * fixtures for a new model — the e2e suite adapts (model/dim are read from
 * the json by tests/e2e/start-server.sh).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compressReceiptImage } from "../src/lib/image";
import { normalizeImageForEmbedding } from "../src/lib/embeddings/provider";
import { sha256Hex } from "../src/lib/embeddings/content";
import { RECEIPTS, QUERIES, ANCHORS } from "../tests/e2e/embedding-fixtures/manifest";

const DIR = path.resolve("tests/e2e/embedding-fixtures");
const ENDPOINT = (process.env.EMBEDDING_ENDPOINT ?? "").replace(/\/+$/, "");
const KEY = process.env.EMBEDDING_API_KEY ?? "";
const MODEL = process.env.EMBEDDING_MODEL || "qwen3-vl-embedding-2b";
const PREFIX =
  process.env.EMBEDDING_QUERY_PREFIX ??
  "Instruct: Retrieve the receipt matching the query. Query: ";

if (!ENDPOINT) {
  console.error("Set EMBEDDING_ENDPOINT (and usually EMBEDDING_API_KEY).");
  process.exit(2);
}

async function call(pathname: string, body: object): Promise<unknown> {
  const res = await fetch(ENDPOINT + pathname, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${pathname} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
function firstVector(json: unknown): number[] {
  const rows = Array.isArray(json) ? json : (json as { data?: unknown[] }).data;
  const e = (rows as { embedding: number[] | number[][] }[])[0].embedding;
  return (Array.isArray(e[0]) ? (e as number[][])[0] : (e as number[])) as number[];
}
const b64 = (v: number[]) =>
  Buffer.from(new Float32Array(v).buffer).toString("base64");
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

async function renderImages(): Promise<void> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 900 } });
  for (const r of RECEIPTS) {
    await page.setContent(r.html, { waitUntil: "networkidle" });
    const paper = page.locator(".paper");
    await paper.screenshot({ path: path.join(DIR, `${r.id}.png`) });
    console.log(`rendered ${r.id}.png`);
  }
  await browser.close();
}

async function main() {
  if (process.argv.includes("--render")) await renderImages();

  const entries: object[] = [];
  const vectors: Record<string, number[]> = {};

  for (const r of RECEIPTS) {
    const png = readFileSync(path.join(DIR, `${r.id}.png`));
    // The app's exact test-time pipeline: upload compression → embed normalize.
    const { data: webp } = await compressReceiptImage(png);
    const jpeg = await normalizeImageForEmbedding(webp);
    const prompt = `A photographed purchase receipt. User note: ${r.note}.`;
    const json = await call("/embeddings", {
      content: [{ prompt_string: `${prompt} <__media__>`, multimodal_data: [jpeg.toString("base64")] }],
    });
    const v = firstVector(json);
    vectors[r.id] = v;
    entries.push({
      id: r.id,
      kind: "image",
      imageSha256: sha256Hex(jpeg),
      // Projection anchor text for prompt-only misses: the note + merchant line.
      text: prompt,
      vector: b64(v),
    });
    console.log(`embedded image ${r.id} (dim ${v.length})`);
  }

  for (const q of QUERIES) {
    const v = firstVector(await call("/v1/embeddings", { model: MODEL, input: PREFIX + q.text }));
    vectors[q.id] = v;
    entries.push({ id: q.id, kind: "query", text: PREFIX + q.text, vector: b64(v) });
    console.log(`embedded query ${q.id}`);
  }
  for (const a of ANCHORS) {
    const v = firstVector(await call("/v1/embeddings", { model: MODEL, input: a.text }));
    vectors[a.id] = v;
    entries.push({ id: a.id, kind: "anchor", text: a.text, vector: b64(v) });
    console.log(`embedded anchor ${a.id}`);
  }

  // The real score matrix the journeys assert against (±ε).
  const expectedScores: Record<string, Record<string, number>> = {};
  for (const q of QUERIES) {
    expectedScores[q.id] = {};
    for (const d of [...RECEIPTS, ...ANCHORS]) {
      expectedScores[q.id][d.id] = Number(dot(vectors[q.id], vectors[d.id]).toFixed(4));
    }
  }

  const dim = Object.values(vectors)[0].length;
  writeFileSync(
    path.join(DIR, "embeddings.json"),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        endpoint: ENDPOINT,
        model: MODEL,
        dim,
        queryPrefix: PREFIX,
        entries,
        expectedScores,
      },
      null,
      1
    )
  );
  console.log(`\nwrote embeddings.json (model ${MODEL}, dim ${dim}, ${entries.length} vectors)`);
  console.table(expectedScores);
}

void main();
