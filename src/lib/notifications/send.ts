import crypto from "crypto";
import fs from "fs";
import path from "path";
import { isPushMock, pushServiceAccountJson } from "./settings";
import type { NotificationKind } from "./catalog";
import { KIND_SPECS } from "./catalog";

/**
 * The send adapter (docs/NOTIFICATIONS_DESIGN.md §4/§7): the ONLY place that
 * talks to FCM. Real mode uses a SECOND, named firebase-admin app so the
 * existing keyless default app (ID-token verification) is untouched; the
 * credential is the messaging-only service account — by IAM construction it
 * cannot read or write the e-sign Firestore ledger. Mock mode (PUSH_MOCK=1)
 * records deliveries to <DATA_DIR>/push-mock.jsonl so suites assert real
 * queue behavior with zero network.
 */

export type SendInput = {
  token: string;
  kind: NotificationKind;
  recipientId: string;
  targetId: string;
  title: string;
  body: string;
  route: string;
};

export type SendResult =
  | { ok: true }
  | { ok: false; prune: boolean; error: string };

/** RFC 8030 Topic: ≤ 32 chars, base64url alphabet ONLY — the readable tag is
 *  both too long and contains ":", which some push services 400 (§7.4). */
export function wireTopic(tag: string): string {
  return crypto.createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

function mockSinkPath(): string {
  return path.join(path.resolve(process.env.DATA_DIR || "./data"), "push-mock.jsonl");
}

function sendMock(input: SendInput): SendResult {
  // A synthetic token that self-describes as dead lets tests exercise the
  // prune path end-to-end.
  if (input.token.includes("unregistered")) {
    return { ok: false, prune: true, error: "messaging/registration-token-not-registered" };
  }
  const line = JSON.stringify({ ...input, at: new Date().toISOString() });
  try {
    fs.mkdirSync(path.dirname(mockSinkPath()), { recursive: true });
    fs.appendFileSync(mockSinkPath(), line + "\n", "utf8");
  } catch (err) {
    console.error("push mock sink write failed:", err);
  }
  return { ok: true };
}

/** Errors that mean the token will never work again (§7.3: delete the row). */
const PRUNE_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-argument",
  "messaging/invalid-registration-token",
]);

async function pushApp() {
  const { getApps, initializeApp, cert } = await import("firebase-admin/app");
  const existing = getApps().find((a) => a.name === "push");
  if (existing) return existing;
  const raw = pushServiceAccountJson();
  if (!raw) throw new Error("FCM_SERVICE_ACCOUNT_JSON is not configured");
  return initializeApp({ credential: cert(JSON.parse(raw)) }, "push");
}

async function sendReal(input: SendInput): Promise<SendResult> {
  const { getMessaging } = await import("firebase-admin/messaging");
  const spec = KIND_SPECS[input.kind];
  const tag = spec.tag(input.recipientId, input.targetId);
  try {
    await getMessaging(await pushApp()).send({
      token: input.token,
      webpush: {
        headers: {
          TTL: String(spec.ttlSeconds),
          Topic: wireTopic(tag),
          Urgency: input.kind === "device-request" ? "high" : "normal",
        },
        notification: {
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
          tag,
          renotify: false,
          icon: "/icon-192.png",
        },
        // The SW is SDK-free (§7.0): it reads data.route from the raw push
        // payload; fcmOptions.link is not used.
        data: { route: input.route },
      },
    });
    return { ok: true };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, prune: PRUNE_CODES.has(code), error: code || message };
  }
}

export async function sendPush(input: SendInput): Promise<SendResult> {
  if (isPushMock()) return sendMock(input);
  return sendReal(input);
}
