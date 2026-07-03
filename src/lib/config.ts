import path from "path";

export { MINISTRIES } from "./ministries";

/** Line-item rows on one page of the official CFCC form (13-row table). */
export const FORM_ROWS_PER_PAGE = 13;

/** Target size for compressed receipt images (bytes). */
export const IMAGE_TARGET_BYTES = 100 * 1024;

/** Root directory for the SQLite db and uploaded files. */
export function dataDir(): string {
  return path.resolve(process.env.DATA_DIR || "./data");
}

export function uploadsDir(): string {
  return path.join(dataDir(), "uploads");
}

export function isAiMock(): boolean {
  return process.env.AI_MOCK === "1";
}

export function isAuthTestMode(): boolean {
  return process.env.AUTH_TEST_MODE === "1";
}
