import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHURCH_CONTEXT_MAX_BYTES,
  loadChurchContext,
  readChurchContextRaw,
  truncateToBytes,
  writeChurchContext,
} from "@/lib/church-context";

// The admin editor writes the same file the suggestion prompt reads fresh.
describe("church context editor", () => {
  const oldEnv = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "numbers-ctx-"));
    process.env.DATA_DIR = dir;
    delete process.env.CHURCH_CONTEXT_PATH;
  });
  afterEach(() => {
    process.env = { ...oldEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no file exists", async () => {
    expect(await readChurchContextRaw()).toBeNull();
    expect(await loadChurchContext()).toBeNull();
  });

  it("round-trips a saved document (hot-read)", async () => {
    await writeChurchContext("# Vocabulary\n- the retreat = Summer Retreat\n");
    expect(await readChurchContextRaw()).toContain("Summer Retreat");
    // loadChurchContext trims to what the AI actually receives.
    expect(await loadChurchContext()).toBe("# Vocabulary\n- the retreat = Summer Retreat");
  });

  it("empty content removes the file (reverts to chart-only)", async () => {
    await writeChurchContext("something");
    expect(await loadChurchContext()).not.toBeNull();
    await writeChurchContext("   ");
    expect(await readChurchContextRaw()).toBeNull();
    expect(await loadChurchContext()).toBeNull();
  });

  it("rejects content past the byte cap", async () => {
    const tooBig = "a".repeat(CHURCH_CONTEXT_MAX_BYTES + 1);
    await expect(writeChurchContext(tooBig)).rejects.toThrow();
    // Nothing was written.
    expect(await readChurchContextRaw()).toBeNull();
  });

  it("accepts content exactly at the cap", async () => {
    const atCap = "a".repeat(CHURCH_CONTEXT_MAX_BYTES);
    await writeChurchContext(atCap);
    expect((await readChurchContextRaw())?.length).toBe(CHURCH_CONTEXT_MAX_BYTES);
  });

  it("caps the loaded prompt document by BYTES, not code units", async () => {
    // A CJK document: each char is 3 UTF-8 bytes. Writing straight to the
    // path (bypassing the byte-checked writer, as an operator would with
    // CHURCH_CONTEXT_PATH) with more than the byte cap of code units must be
    // truncated to the byte budget when loaded, not passed through at ~3×.
    const cjk = "水".repeat(CHURCH_CONTEXT_MAX_BYTES); // way over the byte cap
    fs.writeFileSync(path.join(dir, "church-context.md"), cjk, "utf8");
    const loaded = await loadChurchContext();
    expect(Buffer.byteLength(loaded!, "utf8")).toBeLessThanOrEqual(CHURCH_CONTEXT_MAX_BYTES);
  });
});

describe("truncateToBytes", () => {
  it("leaves strings within budget untouched", () => {
    expect(truncateToBytes("hello", 10)).toBe("hello");
    expect(truncateToBytes("", 4)).toBe("");
  });

  it("never splits a multi-byte character", () => {
    // "水" is 3 bytes; a budget of 4 fits exactly one, not one-and-a-third.
    expect(truncateToBytes("水水水", 4)).toBe("水");
    expect(Buffer.byteLength(truncateToBytes("水水水", 5), "utf8")).toBeLessThanOrEqual(5);
  });

  it("never leaves a lone surrogate from an emoji", () => {
    const out = truncateToBytes("🧾🧾🧾", 5); // each emoji is 4 bytes
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(5);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(out).toBe("🧾");
  });
});
