import fs from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/config";

/**
 * On-disk storage for opt-in feedback screenshots (docs/FEEDBACK_DESIGN.md §5).
 * SERVER ONLY. Bytes live under `<DATA_DIR>/feedback/<reportId>.<ext>`, never a
 * DB blob — same discipline as receipts (`src/lib/storage.ts`). The filename is
 * the report's cuid, so it can't traverse; reads still re-check the resolved
 * path stays inside the feedback dir. Best-effort: a screenshot that won't
 * decode is dropped, never a reason to fail the report.
 */

const MAX_BYTES = 2_500_000;
const EXT_FOR_TYPE: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};
const TYPE_FOR_EXT: Record<string, string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  png: "image/png",
};

function feedbackDir(): string {
  return path.join(dataDir(), "feedback");
}

/** Decode a `data:image/...;base64,...` URL, enforce type + size, write to disk.
 *  Returns the relative path (for `FeedbackReport.screenshotPath`) or null. */
export function saveFeedbackScreenshot(reportId: string, dataUrl: string): string | null {
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const ext = EXT_FOR_TYPE[m[1]];
  if (!ext) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(m[2], "base64");
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.length > MAX_BYTES) return null;
  const dir = feedbackDir();
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join("feedback", `${reportId}.${ext}`);
  fs.writeFileSync(path.join(dataDir(), rel), buf);
  return rel;
}

/** Read a stored screenshot, guarding against path traversal. */
export function readFeedbackScreenshot(
  relPath: string
): { bytes: Buffer; contentType: string } | null {
  if (!relPath) return null;
  const abs = path.resolve(dataDir(), relPath);
  const base = feedbackDir();
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  if (!fs.existsSync(abs)) return null;
  const ext = path.extname(abs).slice(1).toLowerCase();
  return { bytes: fs.readFileSync(abs), contentType: TYPE_FOR_EXT[ext] ?? "application/octet-stream" };
}
