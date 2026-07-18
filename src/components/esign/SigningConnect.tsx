"use client";

/**
 * The explicit "Connect signing on this device" step (docs/ESIGN_DESIGN.md
 * §9.2). Signing on the production Firestore backend needs a Google popup, and
 * iOS/Safari only lets a popup through when window.open runs inside the click
 * that triggered it — so every e-sign surface establishes the session up front
 * from THIS button instead of letting the popup surface mid-ceremony (where an
 * intervening fetch has already forfeited the gesture and Safari blocks it).
 *
 * The mock backend has no Firebase and the emulator signs in silently, so
 * `hasSigningSession` reports "ready" immediately there and this card never
 * shows — the gate is invisible except on the real backend, once per device.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  connectSigningSession,
  hasSigningSession,
  preloadSigningSession,
  type EsignEnv,
} from "@/lib/esign/client";
import { useThrownErrorMessage } from "@/lib/use-api-error";

export type SigningPhase = "checking" | "connect" | "ready";

/** Map a connect failure to a member-facing message, or null when it was just
 *  the member dismissing the Google window (not worth showing). Shared by the
 *  standalone gate and the chain-verification hook so the wording stays one. */
export function connectErrorMessage(
  err: unknown,
  t: (key: "connectBlocked" | "connectFailed") => string,
  thrown: (err: unknown, fallback: string) => string
): string | null {
  const code = (err as { code?: string })?.code ?? "";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
    return null;
  }
  if (code === "auth/popup-blocked") return t("connectBlocked");
  return thrown(err, t("connectFailed"));
}

/**
 * Track whether this device needs the interactive connect step and drive it.
 * `phase` starts "checking" (popup-free probe of the restored session), then
 * settles to "ready" (session usable — render the real UI) or "connect" (show
 * the card). `connect` must be wired to a real click; it opens the popup.
 */
export function useSigningSession(env: EsignEnv | null) {
  const t = useTranslations("Esign");
  const thrown = useThrownErrorMessage();
  const [phase, setPhase] = useState<SigningPhase>("checking");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True only when "ready" was reached by an explicit connect() click, not by a
  // session restored on mount — lets callers auto-advance (e.g. straight into
  // the enroll consent) right after the Google popup without also popping a
  // modal on every later page load. Reset when a new env probe starts.
  const [justConnected, setJustConnected] = useState(false);

  useEffect(() => {
    if (!env) return;
    let cancelled = false;
    setPhase("checking");
    setJustConnected(false);
    void (async () => {
      try {
        // Warm the SDK before we decide, so the connect click reaches
        // signInWithPopup with no async gap (the whole point of this gate).
        await preloadSigningSession(env);
        const ready = await hasSigningSession(env);
        if (!cancelled) setPhase(ready ? "ready" : "connect");
      } catch {
        if (!cancelled) setPhase("connect");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [env]);

  const connect = useCallback(async () => {
    if (!env) return;
    setConnecting(true);
    setError(null);
    try {
      await connectSigningSession(env);
      setJustConnected(true);
      setPhase("ready");
    } catch (err) {
      const message = connectErrorMessage(err, t, thrown);
      if (message) setError(message);
      setConnecting(false);
    }
  }, [env, t, thrown]);

  return { phase, connect, connecting, error, justConnected };
}

/** The connect prompt itself — one obvious button, plain words. */
export function SigningConnectCard({
  connect,
  connecting,
  error,
}: {
  connect: () => void;
  connecting: boolean;
  error: string | null;
}) {
  const t = useTranslations("Esign");
  return (
    <div className="space-y-2 rounded-xl border border-indigo-200 bg-indigo-50 p-4" data-testid="connect-signing">
      <p className="text-sm font-semibold text-indigo-900">{t("connectTitle")}</p>
      <p className="text-xs text-indigo-800/70">{t("connectBody")}</p>
      {error && (
        <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700" data-testid="connect-signing-error">
          {error}
        </p>
      )}
      <button
        className="btn-primary"
        onClick={connect}
        disabled={connecting}
        data-testid="connect-signing-button"
      >
        {connecting ? t("connecting") : t("connectButton")}
      </button>
    </div>
  );
}

/**
 * Wrap an e-sign action region: renders the connect card until this device has
 * a signing session, then the children. `onReady` fires once when the session
 * becomes available (e.g. to kick off a data load the children depend on).
 */
export function SigningGate({
  env,
  onReady,
  children,
}: {
  env: EsignEnv | null;
  onReady?: () => void;
  children: React.ReactNode;
}) {
  const { phase, connect, connecting, error } = useSigningSession(env);
  const [announced, setAnnounced] = useState(false);

  useEffect(() => {
    if (phase === "ready" && !announced) {
      setAnnounced(true);
      onReady?.();
    }
  }, [phase, announced, onReady]);

  if (!env || phase === "checking") return null;
  if (phase === "connect") {
    return <SigningConnectCard connect={connect} connecting={connecting} error={error} />;
  }
  return <>{children}</>;
}
