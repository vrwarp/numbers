/**
 * Feedback outbox (docs/FEEDBACK_DESIGN.md §4). Church wifi is unreliable; a
 * failed POST must not lose the report. Unsent payloads queue in localStorage
 * and flush on the next load / reconnect, with a bounded retry count so a
 * permanently-rejected item can't loop forever. Fire-and-forget: the outbox
 * never throws into the UI.
 */
import type { FeedbackPayload } from "./types";

const KEY = "numbers.fb.outbox";
const MAX_ITEMS = 20;
const MAX_TRIES = 6;

export interface OutboxItem {
  id: string;
  payload: FeedbackPayload;
  tries: number;
}

function load(): OutboxItem[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
  } catch {
    return [];
  }
}

function save(items: OutboxItem[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(-MAX_ITEMS)));
  } catch {
    /* best-effort */
  }
}

export function enqueue(payload: FeedbackPayload): void {
  const items = load();
  const id = `${Date.now().toString(36)}-${Math.floor((typeof performance !== "undefined" ? performance.now() : 0))}`;
  items.push({ id, payload, tries: 0 });
  save(items);
}

export function pendingCount(): number {
  return load().length;
}

/**
 * Try to send every queued item via `send`. Successful and exhausted items are
 * dropped; transient failures stay queued with an incremented try count.
 * Returns the number successfully sent. Never rejects.
 */
export async function flush(send: (p: FeedbackPayload) => Promise<boolean>): Promise<number> {
  const items = load();
  if (items.length === 0) return 0;
  const keep: OutboxItem[] = [];
  let sent = 0;
  for (const item of items) {
    let ok = false;
    try {
      ok = await send(item.payload);
    } catch {
      ok = false;
    }
    if (ok) {
      sent += 1;
      continue;
    }
    const tries = item.tries + 1;
    if (tries < MAX_TRIES) keep.push({ ...item, tries });
    // else: give up silently — an item the server keeps rejecting is not
    // worth nagging the volunteer about.
  }
  save(keep);
  return sent;
}
