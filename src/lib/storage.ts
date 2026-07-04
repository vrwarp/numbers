import fs from "fs/promises";
import path from "path";
import { dataDir, uploadsDir } from "./config";

/** Save a receipt file under DATA_DIR/uploads/<userId>/<fileName>. Returns the path relative to DATA_DIR. */
export async function saveReceiptFile(
  userId: string,
  fileName: string,
  data: Buffer
): Promise<string> {
  const dir = path.join(uploadsDir(), userId);
  await fs.mkdir(dir, { recursive: true });
  const absPath = path.join(dir, fileName);
  await fs.writeFile(absPath, data);
  return path.relative(dataDir(), absPath);
}

/** Read a stored file by its DATA_DIR-relative path, refusing traversal outside DATA_DIR. */
export async function readStoredFile(relPath: string): Promise<Buffer> {
  const abs = path.resolve(dataDir(), relPath);
  if (!abs.startsWith(dataDir() + path.sep)) {
    throw new Error("Invalid file path");
  }
  return fs.readFile(abs);
}

/** DATA_DIR-relative path of a claim's generated packet PDF. Overwritten on
 *  every (re)generation, so it is always the LATEST version — the target the
 *  QR capability link (/c/<publicToken>) serves. */
export function generatedPdfPath(userId: string, reimbursementId: string): string {
  return path.join("generated", userId, `${reimbursementId}.pdf`);
}

/** Persist a claim's generated packet at its well-known path (see above). */
export async function saveGeneratedPdf(
  userId: string,
  reimbursementId: string,
  data: Uint8Array
): Promise<void> {
  const abs = path.resolve(dataDir(), generatedPdfPath(userId, reimbursementId));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);
}

// --- PDF preview cache ------------------------------------------------------
// A PDF receipt's raster preview is per-page WebP images plus a small JSON
// manifest, all beside the original: uploads/<userId>/<id>.pdf →
// …/<id>.preview.json + …/<id>.preview-p1.webp, -p2.webp, …

/** DATA_DIR-relative path of the preview manifest ({pages, omitted}). */
export function previewManifestPath(filePath: string): string {
  return filePath.replace(/\.[^.]+$/, "") + ".preview.json";
}

/** DATA_DIR-relative path of one rendered preview page (1-based). */
export function previewPagePath(filePath: string, page: number): string {
  return filePath.replace(/\.[^.]+$/, "") + `.preview-p${page}.webp`;
}

/** Best-effort removal of a receipt's whole preview cache (manifest, pages,
 *  and any legacy single-strip .preview.jpg). Never throws. */
export async function deletePreviewCache(filePath: string): Promise<void> {
  try {
    const manifest = JSON.parse(
      (await readStoredFile(previewManifestPath(filePath))).toString("utf8")
    ) as { pages?: number };
    for (let p = 1; p <= (manifest.pages ?? 0); p++) {
      await deleteStoredFile(previewPagePath(filePath, p)).catch(() => {});
    }
  } catch {
    // No/unreadable manifest — nothing page-wise to clean.
  }
  await deleteStoredFile(previewManifestPath(filePath)).catch(() => {});
  await deleteStoredFile(filePath.replace(/\.[^.]+$/, "") + ".preview.jpg").catch(() => {});
}

export async function deleteStoredFile(relPath: string): Promise<void> {
  const abs = path.resolve(dataDir(), relPath);
  if (!abs.startsWith(dataDir() + path.sep)) {
    throw new Error("Invalid file path");
  }
  await fs.rm(abs, { force: true });
}
