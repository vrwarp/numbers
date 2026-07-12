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
 *
 * Emulator e2e (docs/agent/TESTING.md): when the server-relayed config
 * carries an `emulator` block, the SDK is pointed at the local auth/firestore
 * emulators and the Google popup is replaced with a silent email/password
 * sign-in as the session's email — same code everywhere else, so the
 * walkthrough exercises the REAL Firestore backend and the real
 * firestore.rules with no live project. The block never exists in production
 * configs (it requires the FIRESTORE_EMULATOR_HOST env pair on the server).
 */

import type { FirebaseApp } from "firebase/app";
import type { FirebaseWebConfig } from "@/components/SignInCard";

let config: FirebaseWebConfig | null = null;
let expectedEmail: string | null = null;
let appPromise: Promise<FirebaseApp> | null = null;

export function configureFirebase(cfg: FirebaseWebConfig, email: string) {
  config = cfg;
  expectedEmail = email.toLowerCase();
}

export function isEmulatorConfigured(): boolean {
  return !!config?.emulator;
}

/**
 * Single-flight app init: several e-sign surfaces (identity card, device
 * banner, ceremony dialogs) bootstrap custody concurrently, and EVERY caller
 * must wait for the emulator connections — a second caller racing past
 * initializeApp would talk to production Google endpoints instead of the
 * emulator suite.
 */
function app(): Promise<FirebaseApp> {
  if (!config) throw new Error("Firebase not configured — call configureFirebase first");
  appPromise ??= (async () => {
    const cfg = config!;
    const { initializeApp, getApps } = await import("firebase/app");
    const existing = getApps()[0];
    if (existing) return existing;
    const created = initializeApp(cfg);
    if (cfg.emulator) {
      const fs = await import("firebase/firestore");
      // Force long polling against the emulator (LetUsMeet's hard-won
      // configuration). Do NOT add the aggressive 5s poll cycle — that is
      // their WebKit-only workaround, and it starves long-running RPCs like
      // runTransaction (rotateKeys' in-transaction crypto) of a stable
      // stream. This SDK version also rejects force+autoDetect together.
      fs.initializeFirestore(created, {
        experimentalForceLongPolling: true,
      });
      const [fsHost, fsPort] = cfg.emulator.firestore.split(":");
      fs.connectFirestoreEmulator(fs.getFirestore(created), fsHost, Number(fsPort));
      const fb = await import("firebase/auth");
      fb.connectAuthEmulator(fb.getAuth(created), `http://${cfg.emulator.auth}`, {
        disableWarnings: true,
      });
    }
    return created;
  })();
  return appPromise;
}

export async function getDb() {
  const { getFirestore } = await import("firebase/firestore");
  return getFirestore(await app());
}

export async function ensureFirebaseAuth(): Promise<void> {
  const theApp = await app();
  const fb = await import("firebase/auth");
  const auth = fb.getAuth(theApp);
  const current = auth.currentUser;
  if (current?.email && current.email.toLowerCase() === expectedEmail) return;

  if (config?.emulator) {
    // Deterministic, popup-free sign-in against the auth emulator: the same
    // email always maps to the same emulator uid, so a member's devices
    // (browser contexts) share one account document, exactly like production.
    const password = "esign-emulator-password";
    try {
      await fb.signInWithEmailAndPassword(auth, expectedEmail!, password);
    } catch {
      try {
        await fb.createUserWithEmailAndPassword(auth, expectedEmail!, password);
      } catch {
        // Lost a create race against another of this member's devices.
        await fb.signInWithEmailAndPassword(auth, expectedEmail!, password);
      }
    }
    return;
  }

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
