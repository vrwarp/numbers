import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONFIG_FILE_NAME,
  configValue,
  configFileHas,
  readConfigFile,
  writeConfigValues,
} from "@/lib/config-file";

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

  it("warns (does not silently swallow) when the file is malformed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A trailing comma — the classic hand-edit that made a fully-populated
    // config.json look "unconfigured" (e.g. Firebase sign-in) with no clue why.
    fs.writeFileSync(
      path.join(dir, CONFIG_FILE_NAME),
      '{ "FIREBASE_API_KEY": "k", }'
    );
    expect(configValue("FIREBASE_API_KEY")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("config.json");
    warn.mockRestore();
  });

  it("warns when the file is valid JSON but not an object", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, CONFIG_FILE_NAME), '["not", "an", "object"]');
    expect(configValue("FIREBASE_API_KEY")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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

// The admin editor writes back to the same file the loader reads.
describe("writeConfigValues (admin editor)", () => {
  const oldEnv = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "numbers-cfgw-"));
    process.env.DATA_DIR = dir;
  });
  afterEach(() => {
    process.env = { ...oldEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file and is readable back immediately (hot-reload)", () => {
    writeConfigValues({ AI_PROVIDER: "google", GEMINI_MODEL: "gemini-x" });
    expect(readConfigFile()).toEqual({ AI_PROVIDER: "google", GEMINI_MODEL: "gemini-x" });
    expect(configValue("AI_PROVIDER")).toBe("google");
    expect(configFileHas("GEMINI_MODEL")).toBe(true);
  });

  it("merges into existing values without clobbering others", () => {
    writeConfigValues({ AI_PROVIDER: "google", GEMINI_MODEL: "a" });
    writeConfigValues({ GEMINI_MODEL: "b" });
    expect(readConfigFile()).toEqual({ AI_PROVIDER: "google", GEMINI_MODEL: "b" });
  });

  it("deletes a key on null, reverting to process.env", () => {
    process.env.AI_PROVIDER = "openrouter";
    writeConfigValues({ AI_PROVIDER: "google" });
    expect(configValue("AI_PROVIDER")).toBe("google");
    writeConfigValues({ AI_PROVIDER: null });
    expect(configFileHas("AI_PROVIDER")).toBe(false);
    expect(configValue("AI_PROVIDER")).toBe("openrouter");
  });

  it("refuses to write DATA_DIR into the file", () => {
    writeConfigValues({ DATA_DIR: "/evil", AI_PROVIDER: "google" });
    expect(readConfigFile().DATA_DIR).toBeUndefined();
    expect(configValue("DATA_DIR")).toBe(dir);
  });

  it("recovers from a malformed existing file", () => {
    fs.writeFileSync(path.join(dir, CONFIG_FILE_NAME), "{not json");
    writeConfigValues({ AI_PROVIDER: "google" });
    expect(readConfigFile()).toEqual({ AI_PROVIDER: "google" });
  });
});
