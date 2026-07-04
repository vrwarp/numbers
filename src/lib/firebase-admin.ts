import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { configValue } from "./config-file";

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
  return { apiKey, authDomain, projectId, appId: configValue("FIREBASE_APP_ID") || undefined };
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
