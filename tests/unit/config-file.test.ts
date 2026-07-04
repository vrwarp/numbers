import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILE_NAME, configValue } from "@/lib/config-file";

// configValue overlays a JSON file under DATA_DIR on top of process.env. Each
// test gets a throwaway DATA_DIR so the loader's mtime cache can't leak state.
describe("configValue (data-dir config file)", () => {
  const oldEnv = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "numbers-cfg-"));
    process.env.DATA_DIR = dir;
  });
  afterEach(() => {
    process.env = { ...oldEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(obj: Record<string, unknown>) {
    fs.writeFileSync(path.join(dir, CONFIG_FILE_NAME), JSON.stringify(obj));
  }

  it("falls back to process.env when no file exists", () => {
    process.env.AI_PROVIDER = "google";
    expect(configValue("AI_PROVIDER")).toBe("google");
    expect(configValue("MISSING_THING")).toBeUndefined();
  });

  it("lets the file override process.env", () => {
    process.env.AI_PROVIDER = "openrouter";
    writeConfig({ AI_PROVIDER: "google" });
    expect(configValue("AI_PROVIDER")).toBe("google");
  });

  it("supplies keys the env lacks and coerces non-strings", () => {
    writeConfig({ AI_RPM_TARGET: 10, AI_MOCK: "1" });
    expect(configValue("AI_RPM_TARGET")).toBe("10");
    expect(configValue("AI_MOCK")).toBe("1");
  });

  it("never sources DATA_DIR from the file", () => {
    writeConfig({ DATA_DIR: "/somewhere/else" });
    expect(configValue("DATA_DIR")).toBe(dir);
  });

  it("ignores a malformed file and uses env", () => {
    fs.writeFileSync(path.join(dir, CONFIG_FILE_NAME), "{not json");
    process.env.AUTH_SECRET = "from-env";
    expect(configValue("AUTH_SECRET")).toBe("from-env");
  });

  it("picks up edits when the file changes on disk", () => {
    writeConfig({ OPENROUTER_MODEL: "model-a" });
    expect(configValue("OPENROUTER_MODEL")).toBe("model-a");
    // Rewrite with a bumped mtime so the cache reloads deterministically.
    writeConfig({ OPENROUTER_MODEL: "model-b" });
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(path.join(dir, CONFIG_FILE_NAME), future, future);
    expect(configValue("OPENROUTER_MODEL")).toBe("model-b");
  });
});
