"use client";

/**
 * Lazy Firebase app/auth/Firestore bootstrap for the REAL (non-mock) e-sign
 * backend (docs/ESIGN_DESIGN.md §9.2). Loaded only from e-sign screens.
 *
 * Verified posture: SignInCard deliberately signs out of Firebase right after
 * exchanging the session cookie, so NO Firebase auth persists between visits.
 * Every e-sign session therefore starts with ensureFirebaseAuth() — a popup
 * that must resolve to the SAME email as the numbers session; a mismatched
 * Google account must not write ledgers under a foreign uid.
 */

import type { FirebaseWebConfig } from "@/components/SignInCard";

let config: FirebaseWebConfig | null = null;
let expectedEmail: string | null = null;

export function configureFirebase(cfg: FirebaseWebConfig, email: string) {
  config = cfg;
  expectedEmail = email.toLowerCase();
}

async function app() {
  if (!config) throw new Error("Firebase not configured — call configureFirebase first");
  const { initializeApp, getApps } = await import("firebase/app");
  return getApps()[0] ?? initializeApp(config);
}

export async function getDb() {
  const { getFirestore } = await import("firebase/firestore");
  return getFirestore(await app());
}

export async function ensureFirebaseAuth(): Promise<void> {
  const fb = await import("firebase/auth");
  const auth = fb.getAuth(await app());
  const current = auth.currentUser;
  if (current?.email && current.email.toLowerCase() === expectedEmail) return;
  const credential = await fb.signInWithPopup(auth, new fb.GoogleAuthProvider());
  const email = credential.user.email?.toLowerCase();
  if (email !== expectedEmail) {
    await fb.signOut(auth).catch(() => {});
    throw new Error(
      `Signed into Google as ${email ?? "an unknown account"}, but this numbers account is ${expectedEmail}. ` +
        "Use the same Google account to sign ledger events."
    );
  }
}
