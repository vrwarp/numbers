import { describe, expect } from "vitest";
import { readNdjsonStream } from "@/lib/ndjson";
import { fuzz, Rng } from "./prng";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

/** Split a byte array at arbitrary (possibly mid-UTF-8-codepoint) offsets. */
function randomChunks(rng: Rng, bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const take = rng.int(1, Math.min(7, bytes.length - pos));
    chunks.push(bytes.slice(pos, pos + take));
    pos += take;
  }
  // Occasionally interleave empty chunks — real network streams do this.
  if (rng.bool(0.3)) chunks.splice(rng.int(0, chunks.length), 0, new Uint8Array(0));
  return chunks;
}

function randomMessage(rng: Rng, i: number): Record<string, unknown> {
  return {
    type: rng.pick(["status", "extracted", "quota-wait", "done", "error"]),
    index: i,
    text: rng.unicodeString(20),
    cents: rng.cents(),
    nested: rng.bool() ? { deep: rng.asciiString(8) } : null,
  };
}

/**
 * The claim-extraction progress UI parses this NDJSON stream live; chunk
 * boundaries are network-controlled, so parsing must be invariant to how
 * the bytes are sliced — including cuts inside multi-byte CJK characters.
 */
describe("readNdjsonStream fuzz", () => {
  fuzz("parses identically regardless of chunk boundaries", { iters: 300 }, async (rng) => {
    const messages = rng.array(rng.int(0, 12), (r, i) => randomMessage(r, i));
    const payload = messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length ? "\n" : "");
    const bytes = new TextEncoder().encode(payload);
    const received: unknown[] = [];
    await readNdjsonStream(streamFromChunks(randomChunks(rng, bytes)), (m) => received.push(m));
    expect(received).toEqual(messages);
  });

  fuzz("a final unterminated line is still delivered", { iters: 200 }, async (rng) => {
    const messages = rng.array(rng.int(1, 8), (r, i) => randomMessage(r, i));
    const payload = messages.map((m) => JSON.stringify(m)).join("\n"); // no trailing \n
    const bytes = new TextEncoder().encode(payload);
    const received: unknown[] = [];
    await readNdjsonStream(streamFromChunks(randomChunks(rng, bytes)), (m) => received.push(m));
    expect(received).toEqual(messages);
  });

  fuzz("blank and whitespace-only lines are skipped", { iters: 200 }, async (rng) => {
    const messages = rng.array(rng.int(1, 6), (r, i) => randomMessage(r, i));
    const noise = () => rng.pick(["", " ", "\t", "  \t "]);
    const payload =
      noise() + "\n" + messages.map((m) => JSON.stringify(m) + "\n" + noise() + "\n").join("");
    const bytes = new TextEncoder().encode(payload);
    const received: unknown[] = [];
    await readNdjsonStream(streamFromChunks(randomChunks(rng, bytes)), (m) => received.push(m));
    expect(received).toEqual(messages);
  });

  fuzz("empty stream delivers nothing", { iters: 50 }, async (rng) => {
    const received: unknown[] = [];
    const chunks = rng.bool() ? [] : [new Uint8Array(0)];
    await readNdjsonStream(streamFromChunks(chunks), (m) => received.push(m));
    expect(received).toEqual([]);
  });

  fuzz("malformed JSON rejects rather than silently continuing", { iters: 100 }, async (rng) => {
    const good = JSON.stringify(randomMessage(rng, 0));
    const bad = rng.pick(["{", "[1,", '{"a":}', "not json", '"unclosed']);
    const bytes = new TextEncoder().encode(`${good}\n${bad}\n`);
    const received: unknown[] = [];
    await expect(
      readNdjsonStream(streamFromChunks(randomChunks(rng, bytes)), (m) => received.push(m))
    ).rejects.toThrow();
    expect(received).toEqual([JSON.parse(good)]);
  });
});
