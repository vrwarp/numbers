"use client";

import { useState } from "react";

export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId?: string;
};

/**
 * Google sign-in via the Firebase client SDK (loaded lazily — only visitors
 * to /signin pay for the bundle), then the ID token is exchanged for our
 * httpOnly session cookie so the rest of the app never touches Firebase.
 */
export default function SignInCard({
  firebaseConfig,
  testMode,
}: {
  firebaseConfig: FirebaseWebConfig | null;
  testMode: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInWithGoogle() {
    if (!firebaseConfig) return;
    setBusy(true);
    setError(null);
    try {
      const { initializeApp, getApps } = await import("firebase/app");
      const { getAuth, GoogleAuthProvider, signInWithPopup, signOut } = await import(
        "firebase/auth"
      );
      const app = getApps()[0] ?? initializeApp(firebaseConfig);
      const auth = getAuth(app);
      const credential = await signInWithPopup(auth, new GoogleAuthProvider());
      const idToken = await credential.user.getIdToken();
      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      // The server cookie is the session; drop the client-side Firebase state.
      await signOut(auth).catch(() => {});
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Sign-in failed");
      }
      window.location.assign("/");
    } catch (err) {
      // Closing the Google popup is not an error worth showing.
      const code = (err as { code?: string })?.code ?? "";
      if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") {
        setError(err instanceof Error ? err.message : "Sign-in failed");
      }
      setBusy(false);
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
        throw new Error(data?.error ?? "Sign-in failed");
      }
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setBusy(false);
    }
  }

  return (
    <>
      {firebaseConfig && (
        <button
          type="button"
          onClick={signInWithGoogle}
          disabled={busy}
          className="btn-primary mt-8 w-full py-3 disabled:opacity-60"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
            <path
              fill="currentColor"
              d="M21.35 11.1H12v2.9h5.3c-.5 2.5-2.6 4.3-5.3 4.3a5.8 5.8 0 1 1 0-11.6c1.5 0 2.8.5 3.8 1.4l2.2-2.2A8.9 8.9 0 0 0 12 3a9 9 0 1 0 0 18c5.2 0 8.9-3.7 8.9-8.9 0-.3 0-.7-.05-1z"
            />
          </svg>
          Sign in with Google
        </button>
      )}

      {!firebaseConfig && !testMode && (
        <p className="mt-8 rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
          No sign-in method is configured. Set <code>FIREBASE_API_KEY</code>,{" "}
          <code>FIREBASE_AUTH_DOMAIN</code> and <code>FIREBASE_PROJECT_ID</code> in the
          environment.
        </p>
      )}

      {testMode && (
        <form
          action={devLogin}
          className="mt-8 space-y-3 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-4 text-left"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
            Dev login (test mode)
          </p>
          <input name="email" type="email" required placeholder="you@example.com" className="input" data-testid="dev-email" />
          <input name="name" type="text" placeholder="Your name" className="input" data-testid="dev-name" />
          <button type="submit" disabled={busy} className="btn-secondary w-full" data-testid="dev-signin">
            Sign in (dev)
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
