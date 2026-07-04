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

/** DATA_DIR-relative path of a receipt's cached raster preview (PDF → JPEG).
 *  Sits beside the original, e.g. uploads/<userId>/<id>.pdf → …/<id>.preview.jpg. */
export function previewCachePath(filePath: string): string {
  return filePath.replace(/\.[^.]+$/, "") + ".preview.jpg";
}

/** DATA_DIR-relative path of the pristine-original sidecar that sits beside a
 *  receipt's working file, e.g. uploads/<userId>/<id>.jpg → …/<id>.orig.jpg.
 *  Image uploads write it with the exact uploaded bytes (which may not be JPEG
 *  despite the extension — sharp and browsers sniff the real format). */
export function originalSidecarPath(filePath: string): string {
  return filePath.replace(/(\.[^.]+)$/, ".orig$1");
}

export async function deleteStoredFile(relPath: string): Promise<void> {
  const abs = path.resolve(dataDir(), relPath);
  if (!abs.startsWith(dataDir() + path.sep)) {
    throw new Error("Invalid file path");
  }
  await fs.rm(abs, { force: true });
}
