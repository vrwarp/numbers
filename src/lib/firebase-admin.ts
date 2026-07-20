import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { configValue } from "./config-file";
import {
  esignEmulatorHosts,
  firebaseAuthDomainHost,
  isFirebaseAuthProxyEnabled,
  publicBaseUrl,
} from "./config";

/**
 * Server-side Firebase: only used to verify ID tokens minted by the client
 * SDK at sign-in. Verification checks the token signature against Google's
 * public certs, so a project id is enough — no service-account key needed.
 */

export function firebaseWebConfig() {
  // Emulator e2e (docs/agent/TESTING.md): a demo project id is all the SDK
  // needs — apiKey/authDomain are placeholders the emulators ignore. The
  // relayed `emulator` block is what makes the browser connect there.
  const emulator = esignEmulatorHosts();
  if (emulator) {
    return {
      apiKey: configValue("FIREBASE_API_KEY") || "demo-api-key",
      authDomain: firebaseAuthDomainHost() ?? "127.0.0.1",
      projectId: configValue("FIREBASE_PROJECT_ID") || "demo-numbers",
      appId: configValue("FIREBASE_APP_ID") || undefined,
      emulator,
    };
  }
  const apiKey = configValue("FIREBASE_API_KEY");
  const projectId = configValue("FIREBASE_PROJECT_ID");
  // With FIREBASE_AUTH_PROXY on, the client talks to our own origin (which
  // reverse-proxies /__/auth to <projectId>.firebaseapp.com) so the sign-in
  // iframe/redirect is first-party — WebKit partitions third-party storage,
  // which breaks the default *.firebaseapp.com authDomain on iOS. In that mode
  // the authDomain comes from PUBLIC_BASE_URL, so FIREBASE_AUTH_DOMAIN is not
  // required; otherwise it is the client authDomain.
  const authDomain = proxiedAuthDomain() ?? firebaseAuthDomainHost();
  if (!apiKey || !projectId || !authDomain) return null;
  return {
    apiKey,
    authDomain,
    projectId,
    appId: configValue("FIREBASE_APP_ID") || undefined,
    // FCM web push (docs/NOTIFICATIONS_DESIGN.md §13): the sender id is
    // client-safe config like the rest; absent unless push is set up.
    messagingSenderId: configValue("FIREBASE_MESSAGING_SENDER_ID") || undefined,
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
