/**
 * Read an NDJSON response body line by line, invoking onLine with each parsed
 * object (including a final unterminated line). Dependency-free — used by
 * client components consuming the claim-extraction progress streams.
 */
/** True while any NDJSON progress stream is being consumed in this tab —
 *  the notification click contract must never navigate away from a live
 *  multi-minute extraction (docs/NOTIFICATIONS_DESIGN.md §7.5). */
export function isStreamActive(): boolean {
  return activeStreams > 0;
}
let activeStreams = 0;

export async function readNdjsonStream<T>(
  body: ReadableStream<Uint8Array>,
  onLine: (msg: T) => void
): Promise<void> {
  activeStreams += 1;
  try {
    await readNdjsonStreamInner(body, onLine);
  } finally {
    activeStreams -= 1;
  }
}

async function readNdjsonStreamInner<T>(
  body: ReadableStream<Uint8Array>,
  onLine: (msg: T) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(JSON.parse(line) as T);
    }
  }
  const tail = buffer.trim();
  if (tail) onLine(JSON.parse(tail) as T);
}
