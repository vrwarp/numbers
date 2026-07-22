import { afterEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { isCanary } from "@/lib/brand/canary";
import { renderBrandIcon } from "@/lib/brand/icons";

// isCanary() reads the CANARY key via the config overlay, which falls back to
// process.env when no config.json defines it.
function setCanary(on: boolean) {
  if (on) process.env.CANARY = "1";
  else delete process.env.CANARY;
}

afterEach(() => {
  delete process.env.CANARY;
});

describe("canary brand", () => {
  it("isCanary tracks the CANARY flag", () => {
    setCanary(false);
    expect(isCanary()).toBe(false);
    setCanary(true);
    expect(isCanary()).toBe(true);
    process.env.CANARY = "0"; // only the exact string "1" counts as on
    expect(isCanary()).toBe(false);
  });

  it("passes the base icon through untouched when not canary", async () => {
    setCanary(false);
    const base = await fs.readFile(path.join(process.cwd(), "assets", "brand", "icon-192.png"));
    const out = await renderBrandIcon("icon-192");
    expect(Buffer.compare(out, base)).toBe(0);
  });

  it("composites a canary flag that keeps the icon a valid same-size PNG", async () => {
    setCanary(true);
    const base = await fs.readFile(path.join(process.cwd(), "assets", "brand", "apple-touch-icon.png"));
    const out = await renderBrandIcon("apple-touch-icon");

    // The badged icon differs from the base but stays a valid 180x180 PNG.
    expect(Buffer.compare(out, base)).not.toBe(0);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(180);
    expect(meta.height).toBe(180);
  });
});
