import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";

/**
 * Server-side Firebase: only used to verify ID tokens minted by the client
 * SDK at sign-in. Verification checks the token signature against Google's
 * public certs, so a project id is enough — no service-account key needed.
 */

export function firebaseWebConfig() {
  const apiKey = process.env.FIREBASE_API_KEY;
  const authDomain = process.env.FIREBASE_AUTH_DOMAIN;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!apiKey || !authDomain || !projectId) return null;
  return { apiKey, authDomain, projectId, appId: process.env.FIREBASE_APP_ID || undefined };
}

export function isFirebaseConfigured(): boolean {
  return firebaseWebConfig() !== null;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<DecodedIdToken> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID must be set");
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getAuth(app).verifyIdToken(idToken);
}
