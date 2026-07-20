"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { isStreamActive } from "@/lib/ndjson";
import { isAllowedClickRoute } from "@/lib/notifications/catalog";
import {
  detectCapability,
  enablePushOnThisDevice,
  pingToken,
  type PushClientConfig,
} from "@/lib/push-client";

/**
 * App-wide notification runtime (mounted like DeviceRequestsBanner):
 *  - the §7.7 ping on load + visibilitychange/focus,
 *  - the §8.7 drift surfaces (reconnect chip / §8.4 resume card /
 *    zero-device banner — chip wins, one at a time),
 *  - the §8.9 foreground surface (SW-posted toast, aria-live polite),
 *  - the §7.5 click contract's page half (navigate on focus+postMessage,
 *    EXCEPT while a claim-generation stream is running).
 */

type Toast = { title: string; body: string; route: string };

const PING_THROTTLE_MS = 60_000;

export default function NotificationsRuntime({
  pushConfig,
  notifyEnabled,
  onboardingStep,
}: {
  pushConfig: PushClientConfig;
  notifyEnabled: boolean;
  onboardingStep: number;
}) {
  const t = useTranslations("Notifications");
  const router = useRouter();
  const [toast, setToast] = useState<Toast | null>(null);
  const [surface, setSurface] = useState<"chip" | "resume" | "zero" | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastPing = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((next: Toast) => {
    setToast(next);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 8000);
  }, []);

  // §7.5: the SW talks to the page here.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; title?: string; body?: string; route?: string };
      if (!data || typeof data !== "object") return;
      const route = isAllowedClickRoute(data.route ?? "") ? (data.route as string) : "/";
      if (data.type === "numbers-push") {
        showToast({ title: data.title ?? "", body: data.body ?? "", route });
      } else if (data.type === "numbers-navigate") {
        // Never destroy a live multi-minute extraction (§7.5) — surface a
        // tappable toast instead and let the user choose.
        if (isStreamActive()) {
          showToast({ title: t("runtime.openWhenReady"), body: "", route });
        } else {
          router.push(route);
        }
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router, showToast, t]);

  // §7.7 ping + §8.7 drift detection.
  const runPing = useCallback(async () => {
    if (!notifyEnabled) return;
    const capability = detectCapability(pushConfig.mock);
    if (capability === "ios-install") {
      // Push-incapable but fixable by finishing §8.4 — only when mid-flow.
      setSurface(onboardingStep > 0 ? "resume" : null);
      return;
    }
    if (capability !== "ok") return; // §8.7: never nag an incapable context
    if (onboardingStep > 0) {
      setSurface("resume");
      return;
    }
    if (Date.now() - lastPing.current < PING_THROTTLE_MS) return;
    lastPing.current = Date.now();
    if (typeof Notification !== "undefined" && Notification.permission !== "granted" && !pushConfig.mock) {
      setSurface("chip");
      return;
    }
    const res = await pingToken(pushConfig);
    if (!res || !res.known) setSurface("chip");
    else if (res.devices.length === 0) setSurface("zero");
    else setSurface(null);
  }, [notifyEnabled, onboardingStep, pushConfig]);

  useEffect(() => {
    void runPing();
    const onVisible = () => {
      if (document.visibilityState === "visible") void runPing();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [runPing]);

  async function reconnect() {
    setBusy(true);
    try {
      const result = await enablePushOnThisDevice(pushConfig);
      if (result.ok) setSurface(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {surface && !dismissed && (
        <div
          className="mx-auto mt-2 flex max-w-6xl items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm"
          role="status"
          data-testid={`notify-surface-${surface}`}
        >
          <span>
            {surface === "chip" && t("runtime.reconnectBody")}
            {surface === "resume" && t("runtime.resumeBody")}
            {surface === "zero" && t("card.noDevices")}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {surface === "chip" && (
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void reconnect()}>
                {busy ? "…" : t("runtime.reconnect")}
              </button>
            )}
            {(surface === "resume" || surface === "zero") && (
              <a className="btn-primary" href="/profile">
                {t("runtime.openSettings")}
              </a>
            )}
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setDismissed(true)}
              aria-label={t("runtime.dismiss")}
            >
              ✕
            </button>
          </span>
        </div>
      )}

      {/* §8.9 foreground surface: same composed text, in-app, polite. */}
      {toast && (
        <div
          className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border border-stone-200 bg-white p-4 shadow-lg"
          role="status"
          aria-live="polite"
          data-testid="notify-toast"
        >
          {toast.title && <p className="text-sm font-semibold">{toast.title}</p>}
          {toast.body && <p className="mt-0.5 text-sm text-stone-600">{toast.body}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setToast(null)}>
              {t("runtime.dismiss")}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                const route = toast.route;
                setToast(null);
                router.push(route);
              }}
            >
              {t("runtime.open")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
