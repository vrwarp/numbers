import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveReceiptFile,
  readStoredFile,
  deleteStoredFile,
  generatedPdfPath,
  saveGeneratedPdf,
  previewManifestPath,
  previewPagePath,
  deletePreviewCache,
} from "@/lib/storage";

/** dataDir() reads DATA_DIR fresh per call, so pointing it at a temp dir
 *  sandboxes the whole module. */
let dir: string;
const prevDataDir = process.env.DATA_DIR;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "numbers-storage-"));
  process.env.DATA_DIR = dir;
});

afterAll(() => {
  process.env.DATA_DIR = prevDataDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("saveReceiptFile / readStoredFile", () => {
  it("round-trips bytes and returns a DATA_DIR-relative path", async () => {
    const rel = await saveReceiptFile("user1", "r1.webp", Buffer.from("hello"));
    expect(path.isAbsolute(rel)).toBe(false);
    expect(rel).toBe(path.join("uploads", "user1", "r1.webp"));
    const back = await readStoredFile(rel);
    expect(back.toString()).toBe("hello");
  });

  it("refuses path traversal outside DATA_DIR on read", async () => {
    await expect(readStoredFile("../../etc/passwd")).rejects.toThrow("Invalid file path");
    await expect(readStoredFile("uploads/../../secrets")).rejects.toThrow("Invalid file path");
    // An absolute path outside DATA_DIR resolves outside it → refused.
    await expect(readStoredFile("/etc/passwd")).rejects.toThrow("Invalid file path");
  });

  it("refuses path traversal on delete, and delete is idempotent inside", async () => {
    await expect(deleteStoredFile("../../tmp/x")).rejects.toThrow("Invalid file path");
    const rel = await saveReceiptFile("user1", "gone.webp", Buffer.from("x"));
    await deleteStoredFile(rel);
    await expect(readStoredFile(rel)).rejects.toThrow(); // ENOENT
    await deleteStoredFile(rel); // force:true — deleting again never throws
  });

  it("refuses reading DATA_DIR itself (empty relative path)", async () => {
    // path.resolve(dataDir(), "") === dataDir(), which lacks the trailing
    // separator the guard requires — the root can never be read as a file.
    await expect(readStoredFile("")).rejects.toThrow("Invalid file path");
  });
});

describe("generated PDFs", () => {
  it("saves the packet at its well-known per-claim path", async () => {
    await saveGeneratedPdf("u2", "claim9", new Uint8Array([1, 2, 3]));
    const rel = generatedPdfPath("u2", "claim9");
    expect(rel).toBe(path.join("generated", "u2", "claim9.pdf"));
    const bytes = await readStoredFile(rel);
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});

describe("PDF preview cache", () => {
  it("derives sibling manifest/page paths from the receipt file path", () => {
    expect(previewManifestPath("uploads/u/r1.pdf")).toBe("uploads/u/r1.preview.json");
    expect(previewPagePath("uploads/u/r1.pdf", 3)).toBe("uploads/u/r1.preview-p3.webp");
  });

  it("deletePreviewCache removes manifest + every page and never throws", async () => {
    const base = await saveReceiptFile("u3", "doc.pdf", Buffer.from("%PDF"));
    await saveReceiptFile("u3", "doc.preview.json", Buffer.from(JSON.stringify({ pages: 2 })));
    await saveReceiptFile("u3", "doc.preview-p1.webp", Buffer.from("a"));
    await saveReceiptFile("u3", "doc.preview-p2.webp", Buffer.from("b"));
    await deletePreviewCache(base);
    await expect(readStoredFile(previewManifestPath(base))).rejects.toThrow();
    await expect(readStoredFile(previewPagePath(base, 1))).rejects.toThrow();
    await expect(readStoredFile(previewPagePath(base, 2))).rejects.toThrow();
    // The original is untouched.
    expect((await readStoredFile(base)).toString()).toBe("%PDF");
    // No manifest at all → still resolves quietly.
    await deletePreviewCache("uploads/u3/never-existed.pdf");
  });
});
