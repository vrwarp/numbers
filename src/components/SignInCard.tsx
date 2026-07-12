"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { Auth, User } from "firebase/auth";

export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId?: string;
  /** Present only in emulator e2e runs (never production): connect the SDK
   *  to the local auth/firestore emulator suite instead of live Firebase. */
  emulator?: { auth: string; firestore: string };
};

type FirebaseAuth = typeof import("firebase/auth");
type LoadedFirebase = { auth: Auth; fb: FirebaseAuth };

// In-app browsers (Messenger, Instagram, etc.) run a sandboxed WebKit view that
// Google's OAuth refuses to serve and whose storage is partitioned from the
// system browser — sign-in cannot work there. Detect them so we can point the
// user at Safari/Chrome instead of failing cryptically.
function isEmbeddedBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /\bFBAN|\bFBAV|FB_IAB|Messenger|Instagram|Line\/|MicroMessenger|; ?wv\)|\bGSA\//.test(ua);
}

/**
 * Google sign-in via the Firebase client SDK (loaded lazily — only visitors
 * to /signin pay for the bundle), then the ID token is exchanged for our
 * httpOnly session cookie so the rest of the app never touches Firebase.
 *
 * We use signInWithPopup (never signInWithRedirect): on iOS every browser is
 * WebKit, and storage partitioning breaks the redirect handler's sessionStorage
 * round-trip ("Unable to process request due to missing initial state"). The
 * popup keeps its handshake in memory and survives partitioning — provided it
 * opens inside the click's user gesture, which is why the modules are preloaded
 * (an await before window.open forfeits the gesture and iOS blocks the popup).
 */
export default function SignInCard({
  firebaseConfig,
  testMode,
}: {
  firebaseConfig: FirebaseWebConfig | null;
  testMode: boolean;
}) {
  const t = useTranslations("SignIn");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [embedded, setEmbedded] = useState(false);
  const loaded = useRef<LoadedFirebase | null>(null);

  async function loadFirebase(): Promise<LoadedFirebase> {
    if (loaded.current) return loaded.current;
    const { initializeApp, getApps } = await import("firebase/app");
    const fb = await import("firebase/auth");
    const app = getApps()[0] ?? initializeApp(firebaseConfig!);
    const auth = fb.getAuth(app);
    loaded.current = { auth, fb };
    return loaded.current;
  }

  async function exchangeSession({ auth, fb }: LoadedFirebase, user: User) {
    const idToken = await user.getIdToken();
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    // The server cookie is the session; drop the client-side Firebase state.
    await fb.signOut(auth).catch(() => {});
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error ?? t("failed"));
    }
    window.location.assign("/");
  }

  function showError(err: unknown) {
    // Closing/cancelling the Google popup is not an error worth showing.
    const code = (err as { code?: string })?.code ?? "";
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
      setBusy(false);
      return;
    }
    if (code === "auth/popup-blocked") {
      setError(t("popupBlocked"));
    } else {
      setError(err instanceof Error ? err.message : t("failed"));
    }
    setBusy(false);
  }

  // Flag in-app browsers and preload the Firebase modules so the popup can open
  // synchronously inside the click handler.
  useEffect(() => {
    if (!firebaseConfig) return;
    setEmbedded(isEmbeddedBrowser());
    loadFirebase().catch(() => {});
  }, [firebaseConfig]);

  async function signInWithGoogle() {
    if (!firebaseConfig) return;
    setError(null);
    setBusy(true);

    // Fast path: modules already preloaded, so signInWithPopup is the very first
    // async call — the browser still counts us as inside the click gesture.
    const ready = loaded.current;
    if (ready) {
      try {
        const credential = await ready.fb.signInWithPopup(ready.auth, new ready.fb.GoogleAuthProvider());
        await exchangeSession(ready, credential.user);
      } catch (err) {
        showError(err);
      }
      return;
    }

    // Preload hadn't finished (very fast click on a cold load): load, then still
    // try the popup. Redirect is deliberately avoided — it fails on iOS.
    try {
      const fresh = await loadFirebase();
      const credential = await fresh.fb.signInWithPopup(fresh.auth, new fresh.fb.GoogleAuthProvider());
      await exchangeSession(fresh, credential.user);
    } catch (err) {
      showError(err);
    }
  }

  async function devLogin(formData: FormData) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/test-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: String(formData.get("email") ?? ""),
          name: String(formData.get("name") ?? ""),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? t("failed"));
      }
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("failed"));
      setBusy(false);
    }
  }

  return (
    <>
      {firebaseConfig && embedded && (
        <div
          className="mt-8 rounded-lg border border-amber-400 bg-amber-100 p-4 text-left text-sm text-amber-900"
          data-testid="signin-embedded-hint"
        >
          <p className="font-semibold">{t("embeddedTitle")}</p>
          <p className="mt-1">{t("embeddedBody")}</p>
        </div>
      )}

      {firebaseConfig && (
        <button
          type="button"
          onClick={signInWithGoogle}
          disabled={busy}
          // In an in-app browser Google will almost certainly reject the flow, but keep the
          // button as a fallback in case detection is wrong — just visibly de-emphasize it.
          className={
            embedded
              ? "btn-primary mt-4 w-full py-3 opacity-60 saturate-50 transition hover:opacity-100 hover:saturate-100 disabled:opacity-40"
              : "btn-primary mt-8 w-full py-3 disabled:opacity-60"
          }
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
            <path
              fill="currentColor"
              d="M21.35 11.1H12v2.9h5.3c-.5 2.5-2.6 4.3-5.3 4.3a5.8 5.8 0 1 1 0-11.6c1.5 0 2.8.5 3.8 1.4l2.2-2.2A8.9 8.9 0 0 0 12 3a9 9 0 1 0 0 18c5.2 0 8.9-3.7 8.9-8.9 0-.3 0-.7-.05-1z"
            />
          </svg>
          {embedded ? t("googleTryAnyway") : t("googleSignIn")}
        </button>
      )}

      {!firebaseConfig && !testMode && (
        <p className="mt-8 rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
          {t.rich("notConfigured", { code: (chunks) => <code>{chunks}</code> })}
        </p>
      )}

      {testMode && (
        <form
          action={devLogin}
          className="mt-8 space-y-3 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-4 text-left"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
            {t("devLogin")}
          </p>
          <input name="email" type="email" required placeholder={t("devEmailPlaceholder")} className="input" data-testid="dev-email" />
          <input name="name" type="text" placeholder={t("devNamePlaceholder")} className="input" data-testid="dev-name" />
          <button type="submit" disabled={busy} className="btn-secondary w-full" data-testid="dev-signin">
            {t("devSignIn")}
          </button>
        </form>
      )}

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700" data-testid="signin-error">
          {error}
        </p>
      )}
    </>
  );
}
