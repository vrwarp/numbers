import { configValue } from "@/lib/config-file";
import { isEsignMock } from "@/lib/config";
import { FIRESTORE_RULES_SOURCE, rulesMatch } from "./firestore-rules-source";

/**
 * Server-side Firestore *rules* management (docs/ESIGN_DESIGN.md §9.2). SERVER
 * ONLY. Two credentials, by design (see README "Managing the rules"):
 *
 *  - a SAVED, read-only key (`FIREBASE_RULES_VIEWER_JSON`, Firebase Rules
 *    Viewer) used only to READ the deployed ruleset and diff it against the
 *    canonical source — it can't rewrite anything, so persisting it can't
 *    enable ledger forgery. rulesHealth() also self-checks that the saved key
 *    really is read-only and flags it if it can write (the store-it-safely
 *    guard, mirroring the push SA scope check).
 *  - an EPHEMERAL admin key (Firebase Rules Admin) passed to deployRules() for
 *    a single deploy and never persisted or logged — deploy power (which could
 *    open the ledger to backdated writes) never lives on the data volume.
 *
 * The numbers server otherwise holds no Firestore-touching credential
 * (invariant 9); these are opt-in and scoped to the Rules service.
 */

const RULES_API = "https://firebaserules.googleapis.com/v1";
const RESOURCE_MANAGER = "https://cloudresourcemanager.googleapis.com/v1";
const FIRESTORE_RELEASE = "cloud.firestore";
const FETCH_TIMEOUT_MS = 15_000;

// Permissions that a *read-only* rules key must NOT have. Any one of these on
// the saved viewer key means it can rewrite rules or Firestore data — i.e. it
// is over-privileged for a stored credential.
const WRITE_PERMISSIONS = [
  "firebaserules.rulesets.create",
  "firebaserules.releases.create",
  "firebaserules.releases.update",
  "datastore.entities.create",
] as const;
const READ_PERMISSION = "firebaserules.releases.get";

export type RulesVerdict =
  | { status: "mock" }
  | { status: "no-key" }
  | { status: "key-invalid" }
  | { status: "key-overprivileged" }
  | { status: "no-project" }
  | { status: "no-release" }
  | { status: "match" }
  | { status: "drift" }
  | { status: "error"; detail: string };

interface ServiceAccount {
  type?: string;
  client_email?: string;
  project_id?: string;
}

function parseServiceAccount(raw: string): ServiceAccount | null {
  try {
    const parsed = JSON.parse(raw) as ServiceAccount;
    if (parsed.type !== "service_account" || !parsed.client_email) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** A non-secret label for a key (its client_email), for display/audit — never
 *  the key itself. */
export function serviceAccountLabel(raw: string): string | null {
  return parseServiceAccount(raw)?.client_email ?? null;
}

let appSeq = 0;

/**
 * Mint an access token from a service-account JSON, run `fn` with it, and
 * ALWAYS tear the firebase-admin app (and its in-memory credential) down after
 * — so a changed viewer key is never served stale, and the EPHEMERAL deploy
 * key's cert never lingers in a cached app (the "never stored" guarantee).
 * Each call uses a unique app name to avoid any cross-call reuse.
 */
async function withToken<T>(raw: string, fn: (token: string) => Promise<T>): Promise<T | null> {
  const { initializeApp, cert, deleteApp } = await import("firebase-admin/app");
  const app = initializeApp({ credential: cert(JSON.parse(raw)) }, `rules-${appSeq++}`);
  try {
    const token = await app.options.credential?.getAccessToken();
    if (!token?.access_token) return null;
    return await fn(token.access_token);
  } finally {
    await deleteApp(app).catch(() => {});
  }
}

async function fetchJson(
  url: string,
  token: string,
  init?: { method?: string; body?: unknown }
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/** Which of a permission set does this credential hold on the project?
 *  testIamPermissions needs no special grant — a caller can always test its
 *  own. Returns null on any failure (caller decides how to treat unknown). */
async function grantedPermissions(
  token: string,
  projectId: string,
  permissions: readonly string[]
): Promise<Set<string> | null> {
  const { ok, json } = await fetchJson(
    `${RESOURCE_MANAGER}/projects/${projectId}:testIamPermissions`,
    token,
    { method: "POST", body: { permissions } }
  );
  if (!ok) return null;
  return new Set((json as { permissions?: string[] })?.permissions ?? []);
}

/** Read the deployed cloud.firestore ruleset source, or a marker. */
async function deployedRulesSource(
  token: string,
  projectId: string
): Promise<{ source: string } | { missing: true } | { error: string }> {
  const rel = await fetchJson(`${RULES_API}/projects/${projectId}/releases/${FIRESTORE_RELEASE}`, token);
  if (rel.status === 404) return { missing: true };
  if (!rel.ok) return { error: `release lookup failed (${rel.status})` };
  const rulesetName = (rel.json as { rulesetName?: string })?.rulesetName;
  if (!rulesetName) return { error: "release has no ruleset" };
  const rs = await fetchJson(`${RULES_API}/${rulesetName}`, token);
  if (!rs.ok) return { error: `ruleset fetch failed (${rs.status})` };
  const files = (rs.json as { source?: { files?: { content?: string }[] } })?.source?.files ?? [];
  const content = files.map((f) => f.content ?? "").join("\n");
  return { source: content };
}

/** Read-only health: is the deployed ruleset the canonical one? Uses the SAVED
 *  viewer key. Fail-soft — every non-match path is a labeled verdict, never a
 *  throw. */
export async function rulesHealth(): Promise<RulesVerdict> {
  if (isEsignMock()) return { status: "mock" };
  const raw = configValue("FIREBASE_RULES_VIEWER_JSON")?.trim();
  if (!raw) return { status: "no-key" };
  const sa = parseServiceAccount(raw);
  if (!sa) return { status: "key-invalid" };
  const projectId = sa.project_id || configValue("FIREBASE_PROJECT_ID")?.trim();
  if (!projectId) return { status: "no-project" };
  try {
    const verdict = await withToken(raw, async (token): Promise<RulesVerdict> => {
      // Store-it-safely guard: a SAVED key must be read-only. If it can write,
      // flag it — a persisted deploy-capable key is the standing-credential risk.
      const perms = await grantedPermissions(token, projectId, [READ_PERMISSION, ...WRITE_PERMISSIONS]);
      if (perms && WRITE_PERMISSIONS.some((p) => perms.has(p))) return { status: "key-overprivileged" };
      const deployed = await deployedRulesSource(token, projectId);
      if ("missing" in deployed) return { status: "no-release" };
      if ("error" in deployed) return { status: "error", detail: deployed.error };
      return rulesMatch(deployed.source, FIRESTORE_RULES_SOURCE) ? { status: "match" } : { status: "drift" };
    });
    return verdict ?? { status: "error", detail: "could not mint an access token" };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : "probe failed" };
  }
}

export type DeployResult =
  | { ok: true; rulesetName: string; keyLabel: string }
  | { ok: false; code: string; detail?: string };

/**
 * Deploy the canonical rules with an EPHEMERAL admin key (never persisted).
 * Creates a ruleset from the embedded source and points the cloud.firestore
 * release at it (creating the release if the database has none yet).
 */
export async function deployRules(rawJson: string): Promise<DeployResult> {
  const sa = parseServiceAccount(rawJson);
  if (!sa) return { ok: false, code: "rules.keyInvalid" };
  const projectId = sa.project_id || configValue("FIREBASE_PROJECT_ID")?.trim();
  if (!projectId) return { ok: false, code: "rules.noProject" };

  let result: DeployResult;
  try {
    result =
      (await withToken(rawJson, async (token): Promise<DeployResult> => {
        const created = await fetchJson(`${RULES_API}/projects/${projectId}/rulesets`, token, {
          method: "POST",
          body: { source: { files: [{ name: "firestore.rules", content: FIRESTORE_RULES_SOURCE }] } },
        });
        if (!created.ok) {
          const detail = (created.json as { error?: { message?: string } })?.error?.message;
          return { ok: false, code: created.status === 403 ? "rules.forbidden" : "rules.rulesetFailed", detail };
        }
        const rulesetName = (created.json as { name?: string })?.name;
        if (!rulesetName) return { ok: false, code: "rules.rulesetFailed" };

        // Point the release at the new ruleset. PATCH updates an existing
        // release; a brand-new database has none, so fall back to create on 404.
        const releaseName = `projects/${projectId}/releases/${FIRESTORE_RELEASE}`;
        const patched = await fetchJson(`${RULES_API}/projects/${projectId}/releases/${FIRESTORE_RELEASE}`, token, {
          method: "PATCH",
          body: { release: { name: releaseName, rulesetName } },
        });
        if (!patched.ok && patched.status === 404) {
          const createdRelease = await fetchJson(`${RULES_API}/projects/${projectId}/releases`, token, {
            method: "POST",
            body: { name: releaseName, rulesetName },
          });
          if (!createdRelease.ok) {
            const detail = (createdRelease.json as { error?: { message?: string } })?.error?.message;
            return { ok: false, code: "rules.releaseFailed", detail };
          }
        } else if (!patched.ok) {
          const detail = (patched.json as { error?: { message?: string } })?.error?.message;
          return { ok: false, code: patched.status === 403 ? "rules.forbidden" : "rules.releaseFailed", detail };
        }
        return { ok: true, rulesetName, keyLabel: sa.client_email ?? "service account" };
      })) ?? { ok: false, code: "rules.tokenFailed" };
  } catch {
    return { ok: false, code: "rules.keyInvalid" };
  }
  return result;
}
