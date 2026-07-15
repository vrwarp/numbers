import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHURCH_CONTEXT_MAX_BYTES,
  loadChurchContext,
  readChurchContextRaw,
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
});
