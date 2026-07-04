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

/** DATA_DIR-relative path of a receipt's cached raster preview (PDF → JPEG).
 *  Sits beside the original, e.g. uploads/<userId>/<id>.pdf → …/<id>.preview.jpg. */
export function previewCachePath(filePath: string): string {
  return filePath.replace(/\.[^.]+$/, "") + ".preview.jpg";
}

export async function deleteStoredFile(relPath: string): Promise<void> {
  const abs = path.resolve(dataDir(), relPath);
  if (!abs.startsWith(dataDir() + path.sep)) {
    throw new Error("Invalid file path");
  }
  await fs.rm(abs, { force: true });
}
