import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { configValue } from "./config-file";
import { isFirebaseAuthProxyEnabled, publicBaseUrl } from "./config";

/**
 * Server-side Firebase: only used to verify ID tokens minted by the client
 * SDK at sign-in. Verification checks the token signature against Google's
 * public certs, so a project id is enough — no service-account key needed.
 */

export function firebaseWebConfig() {
  const apiKey = configValue("FIREBASE_API_KEY");
  const authDomain = configValue("FIREBASE_AUTH_DOMAIN");
  const projectId = configValue("FIREBASE_PROJECT_ID");
  if (!apiKey || !authDomain || !projectId) return null;
  return {
    apiKey,
    // With FIREBASE_AUTH_PROXY on, the client talks to our own origin (which
    // reverse-proxies /__/auth to FIREBASE_AUTH_DOMAIN) so the sign-in
    // iframe/redirect is first-party — WebKit partitions third-party storage,
    // which breaks the default *.firebaseapp.com authDomain on iOS.
    authDomain: proxiedAuthDomain() ?? authDomain,
    projectId,
    appId: configValue("FIREBASE_APP_ID") || undefined,
  };
}

/** App's own host as the client authDomain when the auth proxy is enabled. */
function proxiedAuthDomain(): string | undefined {
  if (!isFirebaseAuthProxyEnabled()) return undefined;
  const base = publicBaseUrl();
  if (!base) return undefined;
  try {
    return new URL(base).host;
  } catch {
    return undefined;
  }
}

export function isFirebaseConfigured(): boolean {
  return firebaseWebConfig() !== null;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<DecodedIdToken> {
  const projectId = configValue("FIREBASE_PROJECT_ID");
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID must be set");
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getAuth(app).verifyIdToken(idToken);
}
