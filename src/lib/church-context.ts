import path from "path";
import { promises as fs } from "fs";
import { dataDir } from "./config";

/**
 * Operator-maintained church knowledge fed into the ministry-suggestion
 * prompt: names of small groups, recurring events, disambiguation rules —
 * the vocabulary the chart of accounts alone can't resolve. Lives on the
 * /data volume (next to the DB and uploads) and is edited by whoever
 * administers the deployment, not through the UI. Deliberately church-wide,
 * not per-user: one church, one vocabulary. See docs/church-context.example.md
 * for the template. SERVER ONLY (fs).
 */

// The document is prepended to every suggestion prompt — keep it bounded.
export const CHURCH_CONTEXT_MAX_BYTES = 16 * 1024;

export function churchContextPath(): string {
  return process.env.CHURCH_CONTEXT_PATH || path.join(dataDir(), "church-context.md");
}

/**
 * Read the context document fresh on every call (it's tiny, and hot-reading
 * means operator edits apply without a restart). Null when the file is
 * missing or empty — the suggestion feature degrades to chart-of-accounts
 * knowledge only.
 */
export async function loadChurchContext(): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(churchContextPath(), "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > CHURCH_CONTEXT_MAX_BYTES
    ? trimmed.slice(0, CHURCH_CONTEXT_MAX_BYTES)
    : trimmed;
}

/**
 * The raw stored document (untrimmed, uncapped) for the admin editor — null
 * when the file is missing. Distinct from loadChurchContext(), which returns
 * the trimmed/capped text the AI actually receives. SERVER ONLY (fs).
 */
export async function readChurchContextRaw(): Promise<string | null> {
  try {
    return await fs.readFile(churchContextPath(), "utf8");
  } catch {
    return null;
  }
}

/**
 * Persist the admin-edited context document. Written atomically (tmp + rename)
 * so a half-written file is never read by a concurrent suggestion call. Empty
 * input removes the file, reverting suggestions to chart-of-accounts only.
 * Throws when the text exceeds the byte cap. SERVER ONLY (fs).
 */
export async function writeChurchContext(text: string): Promise<void> {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > CHURCH_CONTEXT_MAX_BYTES) {
    throw new Error(`Church context exceeds ${CHURCH_CONTEXT_MAX_BYTES}-byte cap`);
  }
  const target = churchContextPath();
  if (!text.trim()) {
    await fs.rm(target, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, target);
}
