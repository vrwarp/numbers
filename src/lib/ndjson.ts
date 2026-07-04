/**
 * Read an NDJSON response body line by line, invoking onLine with each parsed
 * object (including a final unterminated line). Dependency-free — used by
 * client components consuming the claim-extraction progress streams.
 */
export async function readNdjsonStream<T>(
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
