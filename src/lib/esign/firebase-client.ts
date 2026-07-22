"use client";

/**
 * Lazy Firebase app/auth/Firestore bootstrap for the REAL (non-mock) e-sign
 * backend (docs/ESIGN_DESIGN.md §9.2). Loaded only from e-sign screens.
 *
 * Verified posture: SignInCard deliberately signs out of Firebase right after
 * exchanging the session cookie, so the FIRST e-sign surface a device touches
 * starts with ensureFirebaseAuth() — a popup that must resolve to the SAME
 * email as the numbers session; a mismatched Google account must not write
 * ledgers under a foreign uid. The popup's own sign-in persists in the
 * browser, so later visits revalidate the restored session against that same
 * email check instead of re-prompting — the popup only returns when the
 * session is missing or belongs to another account.
 *
 * Installed standalone PWAs can't use the popup: on Android Chrome it opens a
 * Custom Tab whose handshake never returns (the flow HANGS), and on iOS it is
 * blocked outright. So when running standalone we go straight to
 * signInWithRedirect — but only when FIREBASE_AUTH_PROXY has made the redirect
 * handler first-party (authDomain === our own origin), the sole configuration
 * where the redirect round-trip survives third-party-storage restrictions.
 * preloadFirebase() completes that round-trip on the next load. Without the
 * proxy no trusted redirect exists, so the popup runs and surfaces its error.
 * (A popup blocker in a normal tab keeps the error-catch fallback below.)
 * SignInCard applies the same rule to LOGIN.
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
import type { FirestoreSettings } from "firebase/firestore";
import type { Auth } from "firebase/auth";
import type { FirebaseWebConfig } from "@/components/SignInCard";
import { isStandaloneDisplay } from "@/lib/embedded-browser";

type FirebaseAuthModule = typeof import("firebase/auth");

let config: FirebaseWebConfig | null = null;
let expectedEmail: string | null = null;
let appPromise: Promise<FirebaseApp> | null = null;
// Modules + auth handle kept synchronously reachable once preloaded, so
// ensureFirebaseAuth() can open the Google popup with no `await` before
// window.open — the only way iOS/Safari lets a popup through (§9.2, and the
// same trap SignInCard preloads around).
let warm: { auth: Auth; fb: FirebaseAuthModule } | null = null;

export function configureFirebase(cfg: FirebaseWebConfig, email: string) {
  config = cfg;
  expectedEmail = email.toLowerCase();
}

export function isEmulatorConfigured(): boolean {
  return !!config?.emulator;
}

/**
 * Webchannel transport for BOTH backends: XMLHttpRequest, NEVER the Fetch
 * API. WebKit surfaces the fetch transport's aborts and post-sleep failures
 * as "Fetch API cannot load …/Listen/channel … due to access control
 * checks", and in production Safari the Listen+Write backchannels then
 * retry-fail with long polling ALREADY active (CI=0 in the failing URLs) —
 * so the long-poll knobs alone cannot fix it; the XHR transport is immune.
 * `useFetchStreams` is honored by the SDK but missing from the public
 * settings type, hence the casts. Exported for the unit canary
 * (tests/unit/esign-transport.test.ts), which feeds both objects to the
 * real SDK so a firebase upgrade that rejects either combination fails
 * fast instead of at the first production ceremony.
 */
export const FIRESTORE_SETTINGS = {
  // The SDK default, made explicit: autodetect keeps streaming on Chrome
  // and engages long polling on WebKit/buffering proxies.
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false,
} as FirestoreSettings;

/** Emulator delta: additionally force long polling (LetUsMeet's hard-won
 *  configuration). Do NOT add the aggressive 5s poll cycle — that is their
 *  WebKit-only workaround, and it starves long-running RPCs like
 *  runTransaction (rotateKeys' in-transaction crypto) of a stable stream.
 *  The SDK also rejects force+autoDetect together, so force stays
 *  emulator-only. */
export const EMULATOR_FIRESTORE_SETTINGS = {
  experimentalForceLongPolling: true,
  useFetchStreams: false,
} as FirestoreSettings;

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
    const fs = await import("firebase/firestore");
    if (cfg.emulator) {
      fs.initializeFirestore(created, EMULATOR_FIRESTORE_SETTINGS);
      const [fsHost, fsPort] = cfg.emulator.firestore.split(":");
      fs.connectFirestoreEmulator(fs.getFirestore(created), fsHost, Number(fsPort));
      const fb = await import("firebase/auth");
      fb.connectAuthEmulator(fb.getAuth(created), `http://${cfg.emulator.auth}`, {
        disableWarnings: true,
      });
    } else {
      fs.initializeFirestore(created, FIRESTORE_SETTINGS);
    }
    return created;
  })();
  return appPromise;
}

export async function getDb() {
  const { getFirestore } = await import("firebase/firestore");
  return getFirestore(await app());
}

function matchesExpected(user: { email?: string | null } | null): boolean {
  return !!(user?.email && user.email.toLowerCase() === expectedEmail);
}

/**
 * Is signInWithRedirect a trustworthy substitute for the popup here? ONLY when
 * the redirect handler is FIRST-PARTY — FIREBASE_AUTH_PROXY has made the SDK's
 * authDomain our own origin — because a third-party *.firebaseapp.com redirect
 * round-trip is broken by third-party storage access being blocked (WebKit
 * partitioning "missing initial state"; Chrome's third-party cookie
 * phase-out). Never on the emulator (no popup to replace). Pure + exported for
 * the unit canary (tests/unit/esign-firebase-redirect.test.ts).
 */
export function isFirstPartyRedirect(
  cfg: { authDomain?: string; emulator?: unknown } | null,
  host: string
): boolean {
  if (!cfg || cfg.emulator) return false;
  return !!cfg.authDomain && cfg.authDomain === host;
}

/**
 * Should a blocked/unsupported Google popup ERROR fall back to
 * signInWithRedirect? (Secondary path — a popup blocker in a normal tab. The
 * installed-PWA case is handled up front by isStandaloneDisplay(), because
 * there the popup hangs instead of erroring.) First-party redirect only.
 */
export function shouldRedirectAuth(
  cfg: { authDomain?: string; emulator?: unknown } | null,
  errorCode: string,
  host: string
): boolean {
  if (
    errorCode !== "auth/popup-blocked" &&
    errorCode !== "auth/operation-not-supported-in-environment"
  ) {
    return false;
  }
  return isFirstPartyRedirect(cfg, host);
}

let authInFlight: Promise<void> | null = null;

/**
 * Warm the SDK + restore the persisted session ahead of time so a later
 * ensureFirebaseAuth() can reach signInWithPopup synchronously (see `warm`).
 * Never opens the popup itself — safe to call on mount / outside a gesture.
 * No-op on the emulator, which signs in silently with no popup to warm.
 */
export async function preloadFirebase(): Promise<void> {
  if (!config || config.emulator) return;
  const theApp = await app();
  const fb = await import("firebase/auth");
  const auth = fb.getAuth(theApp);
  // Complete a signInWithRedirect round-trip started by the popup-blocked
  // fallback (installed PWA / partitioned WebKit) on a previous page load.
  // Enforce the same same-email guard the popup path does, so a mismatched
  // Google account is signed back out and never used to write ledgers.
  const redirected = await fb.getRedirectResult(auth).catch(() => null);
  if (redirected?.user && !matchesExpected(redirected.user)) {
    await fb.signOut(auth).catch(() => {});
  }
  await auth.authStateReady();
  warm = { auth, fb };
}

/**
 * Is a Firebase session for THIS numbers account already restored on this
 * device? Popup-free (never calls signInWithPopup) so the connect gate can
 * decide whether the interactive step is needed without prompting. On the
 * emulator there is no popup to gate, so callers treat it as "no gate needed"
 * upstream; here we report the literal session state.
 */
export async function hasMatchingFirebaseSession(): Promise<boolean> {
  const theApp = await app();
  const fb = await import("firebase/auth");
  const auth = fb.getAuth(theApp);
  await auth.authStateReady();
  warm ??= { auth, fb };
  return matchesExpected(auth.currentUser);
}

export async function ensureFirebaseAuth(): Promise<void> {
  // Gesture-safe fast path (iOS/Safari): once preloaded, reach signInWithPopup
  // with NO intervening await, so window.open fires inside the click that
  // called us — anything else and the popup is blocked. The emulator never
  // pops, so it always takes the slow (silent) path below.
  if (warm && !config?.emulator) {
    if (matchesExpected(warm.auth.currentUser)) return;
    authInFlight ??= signIn(warm.auth, warm.fb).finally(() => {
      authInFlight = null;
    });
    return authInFlight;
  }
  const theApp = await app();
  const fb = await import("firebase/auth");
  const auth = fb.getAuth(theApp);
  // currentUser stays null until the SDK finishes restoring any persisted
  // session; deciding before authStateReady() would re-open the Google popup
  // at an already-signed-in member on every full page load.
  await auth.authStateReady();
  warm ??= { auth, fb };
  if (matchesExpected(auth.currentUser)) return;
  // Single-flight the sign-in: e-sign surfaces bootstrap concurrently, and a
  // second signInWithPopup while one is pending cancels the first popup
  // (auth/cancelled-popup-request) and opens another — share one attempt.
  authInFlight ??= signIn(auth, fb).finally(() => {
    authInFlight = null;
  });
  return authInFlight;
}

/** Fire cb once a Firebase session matching the numbers account exists —
 *  restored from persistence OR acquired later by another surface's sign-in.
 *  Never opens the popup itself. Returns the listener's unsubscribe. */
export async function onMatchingFirebaseAuth(cb: () => void): Promise<() => void> {
  const theApp = await app();
  const fb = await import("firebase/auth");
  return fb.onAuthStateChanged(fb.getAuth(theApp), (user) => {
    if (matchesExpected(user)) cb();
  });
}

async function signIn(
  auth: import("firebase/auth").Auth,
  fb: typeof import("firebase/auth")
): Promise<void> {
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

  // Installed standalone PWA: signInWithPopup HANGS on Android (the Custom Tab
  // never hands the credential back) and is blocked on iOS. Detect it up front
  // and go straight to the first-party redirect — waiting for a popup error
  // that never comes is the "e-sign setup gets stuck in the PWA" bug. This
  // navigates away; preloadFirebase() completes the round-trip (and re-runs
  // the same-email guard) on the next load. Without the auth proxy no trusted
  // redirect exists, so we fall through and let the popup surface its error.
  if (isStandaloneDisplay() && isFirstPartyRedirect(config, window.location.host)) {
    await fb.signInWithRedirect(auth, new fb.GoogleAuthProvider());
    return;
  }

  let credential: import("firebase/auth").UserCredential;
  try {
    credential = await fb.signInWithPopup(auth, new fb.GoogleAuthProvider());
  } catch (err) {
    // Secondary path: a popup blocker in a normal browser tab. (The installed
    // PWA is handled above — there the popup hangs instead of erroring.) When
    // the redirect handler is first-party, fall back instead of dead-ending —
    // the same escape hatch SignInCard uses to log in.
    const code = (err as { code?: string })?.code ?? "";
    if (shouldRedirectAuth(config, code, window.location.host)) {
      await fb.signInWithRedirect(auth, new fb.GoogleAuthProvider());
      return;
    }
    throw err;
  }
  const email = credential.user.email?.toLowerCase();
  if (email !== expectedEmail) {
    await fb.signOut(auth).catch(() => {});
    throw new Error(
      `Signed into Google as ${email ?? "an unknown account"}, but this numbers account is ${expectedEmail}. ` +
        "Use the same Google account to sign ledger events."
    );
  }
}
