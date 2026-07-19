/**
 * Replay embedding server for e2e (docs/SEARCH_DESIGN.md §11): serves the
 * REAL vectors recorded from a live endpoint by `npm run record:embeddings`
 * (tests/e2e/embedding-fixtures/embeddings.json), so search journeys exercise
 * genuine model geometry — cross-language ranking included — with no network.
 *
 * Resolution:
 *  - image (native /embeddings with multimodal_data): sha256 of the normalized
 *    JPEG → verbatim recorded vector (the recorder ran the app's own pipeline,
 *    so bytes match). Miss → prompt-text projection + a loud warning.
 *  - text (/v1/embeddings, or native without media): exact recorded string →
 *    verbatim vector; otherwise PROJECTION into recorded space: token-overlap
 *    weighted sum of anchor vectors, blended with a deterministic hash-bag
 *    component (near-orthogonal to real vectors) so ANY two texts sharing
 *    tokens correlate — dynamic claim composites land near their anchors,
 *    arbitrary spec queries still rank by wording.
 *  - any text containing __EMBED_FAIL__ → 500 (degraded-mode lever).
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// 3197: NOT 3101 — that is the e-sign e2e app server; a leftover mock on it
// makes reuseExistingServer mistake embedding JSON for the app and hang the suite.
const PORT = Number(process.env.MOCK_EMBED_PORT ?? 3197);
const fixtures = JSON.parse(
  readFileSync(path.resolve("tests/e2e/embedding-fixtures/embeddings.json"), "utf8")
);
const DIM = fixtures.dim;

const decode = (b64) => {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
const byImageSha = new Map();
const byText = new Map();
const anchors = []; // {tokens, vector} — every recorded entry doubles as an anchor
for (const e of fixtures.entries) {
  const v = decode(e.vector);
  if (e.imageSha256) byImageSha.set(e.imageSha256, v);
  if (e.text) {
    byText.set(e.text, v);
    anchors.push({ tokens: tokenBag(e.text), vector: v });
  }
}

function tokenBag(text) {
  const norm = text.normalize("NFKC").toLowerCase();
  const bag = new Map();
  for (const word of norm.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    if (/[㐀-鿿]/.test(word)) {
      const chars = [...word];
      if (chars.length === 1) bag.set(word, (bag.get(word) ?? 0) + 1);
      for (let i = 0; i + 1 < chars.length; i++) {
        const bi = chars[i] + chars[i + 1];
        bag.set(bi, (bag.get(bi) ?? 0) + 1);
      }
    } else {
      bag.set(word, (bag.get(word) ?? 0) + 1);
    }
  }
  return bag;
}
function bagCos(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [, c] of a) na += c * c;
  for (const [, c] of b) nb += c * c;
  for (const [t, c] of a) if (b.has(t)) dot += c * b.get(t);
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
function hashBag(bag) {
  const v = new Float32Array(DIM);
  for (const [token, count] of bag) {
    const h = createHash("sha256").update(`replay ${token}`).digest();
    for (let k = 0; k < 4; k++) {
      const idx = h.readUInt16LE(k * 4) % DIM;
      const sign = h[k * 4 + 2] & 1 ? 1 : -1;
      v[idx] += sign * count * (1 + (h[k * 4 + 3] % 7) / 8);
    }
  }
  return v;
}
function normalize(v) {
  let n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (!n) {
    v[0] = 1;
    n = 1;
  }
  return Float32Array.from(v, (x) => x / n);
}

function resolveText(text) {
  const exact = byText.get(text);
  if (exact) return exact;
  const bag = tokenBag(text);
  const v = new Float32Array(DIM);
  for (const a of anchors) {
    const w = bagCos(bag, a.tokens);
    if (w > 0.1) for (let i = 0; i < DIM; i++) v[i] += w * a.vector[i];
  }
  const hash = normalize(hashBag(bag));
  for (let i = 0; i < DIM; i++) v[i] += 0.6 * hash[i];
  return normalize(v);
}

function resolveContentItem(item) {
  const media = item.multimodal_data ?? [];
  if (media.length) {
    const sha = createHash("sha256").update(Buffer.from(media[0], "base64")).digest("hex");
    const hit = byImageSha.get(sha);
    if (hit) return hit;
    console.warn(`[mock-embed] image sha miss (${sha.slice(0, 12)}…) — projecting prompt text`);
    return resolveText(item.prompt_string ?? "");
  }
  return resolveText(item.prompt_string ?? "");
}

const server = createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: fixtures.model, dim: DIM }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const json = JSON.parse(body || "{}");
      const inputs =
        req.url?.startsWith("/v1/") || json.input !== undefined
          ? [json.input].flat().map((text) => ({ text }))
          : (json.content ?? []).map((item) => ({ item }));
      const texts = inputs.map((i) => i.text ?? i.item?.prompt_string ?? "");
      if (texts.some((t) => String(t).includes("__EMBED_FAIL__"))) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 500, message: "replay: forced failure" } }));
        return;
      }
      const vectors = inputs.map((i) =>
        i.text !== undefined ? resolveText(String(i.text)) : resolveContentItem(i.item)
      );
      const payload =
        req.url?.startsWith("/v1/")
          ? { model: fixtures.model, object: "list", data: vectors.map((v, index) => ({ index, embedding: [...v] })) }
          : vectors.map((v, index) => ({ index, embedding: [...v] }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err) } }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-embed] replaying ${fixtures.model} (dim ${DIM}) on :${PORT}`);
});
