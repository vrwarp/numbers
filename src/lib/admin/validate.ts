import { configValue } from "@/lib/config-file";
import { isAiMock } from "@/lib/config";
import { callProvider, type AiProvider } from "@/lib/ai/providers";
import { serviceAccountScopeCheck } from "@/lib/notifications/settings";
import { parseQuietWindows } from "@/lib/notifications/settings";
import { probeEndpoint, EmbedError } from "@/lib/embeddings/provider";
import { embeddingSettings } from "@/lib/embeddings/settings";
import { isEmbeddingMock } from "@/lib/embeddings/settings-shared";

/**
 * Setup-wizard dry-run validation (docs/ADMIN.md). Each service runs a set of
 * checks against DRAFT values (what the admin just typed, secrets included)
 * falling back to the currently-stored config — WITHOUT persisting anything.
 * Checks return machine `code`s the client translates (Admin.checks.*), so
 * this module stays locale-free like every other server surface. SERVER ONLY.
 */

export const SETUP_SERVICES = ["push", "ai", "firebase", "search"] as const;
export type SetupService = (typeof SETUP_SERVICES)[number];

export function isSetupService(v: string): v is SetupService {
  return (SETUP_SERVICES as readonly string[]).includes(v);
}

export type CheckStatus = "ok" | "warn" | "fail";
export type Check = { status: CheckStatus; code: string; params?: Record<string, string | number> };

/** Draft value if the admin typed one, else the stored config value. */
function picker(values: Record<string, string>) {
  return (key: string): string => {
    const draft = values[key];
    if (typeof draft === "string" && draft.trim() !== "") return draft.trim();
    return (configValue(key) ?? "").trim();
  };
}

const TEST_TIMEOUT_MS = 15_000;

async function validatePush(values: Record<string, string>): Promise<Check[]> {
  const pick = picker(values);
  const checks: Check[] = [];
  if (configValue("PUSH_MOCK") === "1") {
    checks.push({ status: "ok", code: "push.mock" });
    return checks;
  }

  const vapid = pick("FIREBASE_VAPID_PUBLIC_KEY");
  checks.push(vapid ? { status: "ok", code: "push.vapidPresent" } : { status: "fail", code: "push.vapidMissing" });

  const sender = pick("FIREBASE_MESSAGING_SENDER_ID");
  checks.push(sender ? { status: "ok", code: "push.senderPresent" } : { status: "warn", code: "push.senderMissing" });

  const saRaw = values.FCM_SERVICE_ACCOUNT_JSON?.trim() || configValue("FCM_SERVICE_ACCOUNT_JSON") || "";
  if (!saRaw) {
    checks.push({ status: "fail", code: "push.saMissing" });
  } else {
    let parsed: { client_email?: string; type?: string } | null = null;
    try {
      parsed = JSON.parse(saRaw);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.type !== "service_account" || !parsed.client_email) {
      checks.push({ status: "fail", code: "push.saInvalid" });
    } else {
      checks.push({ status: "ok", code: "push.saParsed", params: { email: parsed.client_email } });
      // The load-bearing check: the messaging-only scope (never Firebase Admin).
      const scope = await serviceAccountScopeCheck(saRaw);
      checks.push(
        scope === "ok" || scope === "mock"
          ? { status: "ok", code: "push.scopeOk" }
          : scope === "broad"
            ? { status: "fail", code: "push.scopeBroad" }
            : { status: "warn", code: "push.scopeUnknown" }
      );
    }
  }

  const quiet = pick("NOTIFY_QUIET");
  if (quiet) {
    const windows = parseQuietWindows(quiet);
    checks.push(
      windows.length > 0
        ? { status: "ok", code: "push.quietValid", params: { count: windows.length } }
        : { status: "warn", code: "push.quietInvalid" }
    );
  }
  return checks;
}

async function validateAi(values: Record<string, string>): Promise<Check[]> {
  const pick = picker(values);
  const checks: Check[] = [];

  const providerRaw = (pick("AI_PROVIDER") || "openrouter").toLowerCase();
  if (providerRaw !== "openrouter" && providerRaw !== "google") {
    checks.push({ status: "fail", code: "ai.providerInvalid", params: { provider: providerRaw } });
    return checks;
  }
  const provider = providerRaw as AiProvider;
  checks.push({ status: "ok", code: "ai.providerSelected", params: { provider } });

  const modelKey = provider === "google" ? "GEMINI_MODEL" : "OPENROUTER_MODEL";
  const keyKey = provider === "google" ? "GEMINI_API_KEY" : "OPENROUTER_API_KEY";
  const model = pick(modelKey) || (provider === "google" ? "gemini-3.1-flash-lite" : "google/gemini-3.1-flash-lite");
  checks.push({ status: "ok", code: "ai.modelPresent", params: { model } });

  if (isAiMock()) {
    checks.push({ status: "ok", code: "ai.mock" });
    return checks;
  }

  const apiKey = values[keyKey]?.trim() || configValue(keyKey) || "";
  if (!apiKey) {
    checks.push({ status: "fail", code: "ai.keyMissing", params: { key: keyKey } });
    return checks;
  }

  // Live dry run: a one-token text completion proves the key + model resolve.
  const t0 = Date.now();
  try {
    const reply = await Promise.race([
      callProvider(provider, apiKey, model, "Reply with the single word: OK"),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), TEST_TIMEOUT_MS)
      ),
    ]);
    checks.push({
      status: "ok",
      code: "ai.callOk",
      params: { ms: Date.now() - t0, sample: String(reply).slice(0, 40) },
    });
  } catch (err) {
    checks.push({
      status: "fail",
      code: "ai.callFailed",
      params: { error: (err instanceof Error ? err.message : String(err)).slice(0, 200) },
    });
  }
  return checks;
}

function validateFirebase(values: Record<string, string>): Check[] {
  const pick = picker(values);
  const checks: Check[] = [];

  const apiKey = pick("FIREBASE_API_KEY");
  checks.push(apiKey ? { status: "ok", code: "firebase.apiKey" } : { status: "fail", code: "firebase.apiKeyMissing" });

  const projectId = pick("FIREBASE_PROJECT_ID");
  checks.push(projectId ? { status: "ok", code: "firebase.projectId" } : { status: "fail", code: "firebase.projectIdMissing" });

  const proxyOn = pick("FIREBASE_AUTH_PROXY") === "1";
  const baseUrl = pick("PUBLIC_BASE_URL");
  const authDomain = pick("FIREBASE_AUTH_DOMAIN");
  if (proxyOn) {
    // In proxy mode the client authDomain comes from PUBLIC_BASE_URL's host.
    checks.push(baseUrl ? { status: "ok", code: "firebase.proxyBaseUrl" } : { status: "fail", code: "firebase.proxyNeedsBaseUrl" });
  } else {
    checks.push(authDomain ? { status: "ok", code: "firebase.authDomain" } : { status: "fail", code: "firebase.authDomainMissing" });
  }
  return checks;
}

async function validateSearch(values: Record<string, string>): Promise<Check[]> {
  const checks: Check[] = [];
  if (isEmbeddingMock()) {
    checks.push({ status: "ok", code: "search.mock" });
    return checks;
  }
  const stored = await embeddingSettings();
  const endpoint = (values.endpoint?.trim() || stored?.endpoint || configValue("EMBEDDING_ENDPOINT") || "").trim();
  const model =
    (values.model?.trim() || stored?.model || configValue("EMBEDDING_MODEL") || "").trim() || "qwen3-vl-embedding-2b";
  const apiKey = values.apiKey?.trim() || stored?.apiKey || configValue("EMBEDDING_API_KEY") || "";

  if (!endpoint) {
    checks.push({ status: "fail", code: "search.endpointMissing" });
    return checks;
  }
  checks.push({ status: "ok", code: "search.endpointPresent" });

  try {
    const probe = await probeEndpoint({ endpoint, apiKey, model });
    checks.push({ status: "ok", code: "search.probeOk", params: { dim: probe.dim, ms: probe.ms } });
  } catch (err) {
    checks.push({
      status: "fail",
      code: "search.probeFailed",
      params: { error: (err instanceof EmbedError || err instanceof Error ? err.message : String(err)).slice(0, 200) },
    });
  }
  return checks;
}

export async function validateService(
  service: SetupService,
  values: Record<string, string>
): Promise<Check[]> {
  switch (service) {
    case "push":
      return validatePush(values);
    case "ai":
      return validateAi(values);
    case "firebase":
      return validateFirebase(values);
    case "search":
      return validateSearch(values);
  }
}
