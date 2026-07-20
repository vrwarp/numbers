"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations, useFormatter } from "next-intl";
import { useModalDismiss } from "@/lib/use-modal-dismiss";
import { useApiErrorMessage } from "@/lib/use-api-error";
import {
  detectCapability,
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  pingToken,
  type PushCapability,
  type PushClientConfig,
  type TokenResponse,
} from "@/lib/push-client";

/**
 * Profile → Notifications card (docs/NOTIFICATIONS_DESIGN.md §8): the
 * account-level master switch (the ONE reliable undo), per-category toggles
 * with concrete examples, the per-device enable flow behind a soft-ask, the
 * device list, the self-test, and every §8.3-step-0 capability state — the
 * card never sells what this context can't deliver.
 */

type ProfileUser = {
  notifyEnabled: boolean;
  notifySigning: boolean;
  notifyClaimProgress: boolean;
  notifyFinance: boolean;
  notifySecurity: boolean;
  notifyDiscreet: boolean;
};
type Duties = { approvals: boolean; finance: boolean; admin: boolean };

type CategoryKey = "notifySigning" | "notifyClaimProgress" | "notifyFinance" | "notifySecurity" | "notifyDiscreet";

function CategoryRow({
  id,
  name,
  example,
  on,
  busy,
  onToggle,
  t,
}: {
  id: CategoryKey;
  name: string;
  example: string;
  on: boolean;
  busy: boolean;
  onToggle: (key: CategoryKey, next: boolean) => void;
  t: ReturnType<typeof useTranslations<"Notifications">>;
}) {
  // The DutyRow idiom: visible on/off state text beside the control — color
  // is never the only signal (§8.9), targets stay comfortably large.
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${
        on ? "border-emerald-200 bg-emerald-50" : "border-stone-200 bg-stone-50"
      }`}
      data-testid={`notify-${id}`}
    >
      <div className="text-sm">
        <p className="font-semibold">{name}</p>
        <p className="text-xs text-stone-500">{example}</p>
      </div>
      <button
        type="button"
        className={`min-w-24 shrink-0 whitespace-nowrap ${on ? "btn-secondary" : "btn-primary"}`}
        disabled={busy}
        onClick={() => onToggle(id, !on)}
        data-testid={`notify-${id}-toggle`}
      >
        {busy ? "…" : on ? t("card.turnOff") : t("card.turnOn")}
      </button>
    </div>
  );
}

export default function NotificationsCard({ pushConfig }: { pushConfig: PushClientConfig }) {
  const t = useTranslations("Notifications");
  const format = useFormatter();
  const locale = useLocale();
  const apiError = useApiErrorMessage();

  const [user, setUser] = useState<ProfileUser | null>(null);
  const [duties, setDuties] = useState<Duties | null>(null);
  const [devices, setDevices] = useState<TokenResponse["devices"]>([]);
  const [capability, setCapability] = useState<PushCapability | null>(null);
  const [thisDeviceLive, setThisDeviceLive] = useState<boolean | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [softAskOpen, setSoftAskOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [selfTestAt, setSelfTestAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [installMarked, setInstallMarked] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDismiss(dialogRef, () => setSoftAskOpen(false), softAskOpen);

  const refreshDevices = useCallback(async () => {
    const res = await fetch("/api/notifications/token").catch(() => null);
    if (res?.ok) {
      const data = (await res.json()) as { devices: TokenResponse["devices"] };
      setDevices(data.devices);
    }
  }, []);

  useEffect(() => {
    setCapability(detectCapability(pushConfig.mock));
    // Mock mode never touches the real Notification permission (the enable
    // path is synthetic), so a browser default of "denied" — common in
    // headless CI Chromium — must not gate the mock flow.
    setPermissionDenied(
      !pushConfig.mock &&
        typeof Notification !== "undefined" &&
        Notification.permission === "denied"
    );
    fetch("/api/profile")
      .then((r) => r.json())
      .then(({ user, duties }) => {
        setUser(user);
        setDuties(duties ?? null);
      })
      .catch(() => setError(t("card.loadFailed")));
    void refreshDevices();
    // Whether THIS installation is registered and known (§7.7 ping).
    pingToken(pushConfig).then((res) => setThisDeviceLive(res ? res.known : false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function patchProfile(data: Partial<Record<CategoryKey | "notifyEnabled", boolean>>) {
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      throw new Error(apiError(await res.json().catch(() => null), t("card.saveFailed")));
    }
    const { user } = (await res.json()) as { user: ProfileUser };
    setUser(user);
  }

  async function onToggleCategory(key: CategoryKey, next: boolean) {
    setBusyKey(key);
    setError(null);
    try {
      await patchProfile({ [key]: next });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  /** The soft-ask's confirm: native prompt + token registration + master on —
   *  all from this one gesture (§8.3 step 2). */
  async function confirmSoftAsk() {
    setBusyKey("enable");
    setError(null);
    try {
      const result = await enablePushOnThisDevice(pushConfig);
      if (!result.ok) {
        if (result.reason === "denied") setPermissionDenied(true);
        else setError(t("card.enableFailed"));
        setSoftAskOpen(false);
        return;
      }
      if (!user?.notifyEnabled) await patchProfile({ notifyEnabled: true });
      setDevices(result.devices);
      setThisDeviceLive(true);
      setSoftAskOpen(false);
      // Enabling completes the §8.4 onboarding, whatever step it was on.
      void fetch("/api/notifications/ui-state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboardingStep: 0 }),
      }).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function turnAllOff() {
    setBusyKey("master");
    setError(null);
    try {
      await patchProfile({ notifyEnabled: false });
      await disablePushOnThisDevice(pushConfig).catch(() => {});
      setThisDeviceLive(false);
      await refreshDevices();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function turnOffThisDevice() {
    setBusyKey("device");
    setError(null);
    try {
      await disablePushOnThisDevice(pushConfig);
      setThisDeviceLive(false);
      await refreshDevices();
    } finally {
      setBusyKey(null);
    }
  }

  async function removeDevice(id: string) {
    setBusyKey(`remove-${id}`);
    try {
      const res = await fetch("/api/notifications/token", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        const data = (await res.json()) as { devices: TokenResponse["devices"] };
        setDevices(data.devices);
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function sendSelfTest() {
    setBusyKey("selftest");
    setError(null);
    try {
      const res = await fetch("/api/notifications/self-test", { method: "POST" });
      if (!res.ok) {
        throw new Error(apiError(await res.json().catch(() => null), t("card.saveFailed")));
      }
      // §8.9: confirm IN PAGE, independent of the notification arriving.
      setSelfTestAt(format.dateTime(new Date(), { timeStyle: "short" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function markInstalled() {
    setInstallMarked(true);
    await fetch("/api/notifications/ui-state", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingStep: 2 }),
    }).catch(() => {});
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard unavailable (some webviews) — the URL bar still exists.
    }
  }

  if (!pushConfig.configured) {
    return (
      <section className="card p-5" aria-labelledby="notify-title" data-testid="notifications-card">
        <h2 id="notify-title" className="text-lg font-bold">
          {t("card.title")}
        </h2>
        <p className="mt-2 text-sm text-stone-500">{t("card.notConfigured")}</p>
      </section>
    );
  }

  const enabled = user?.notifyEnabled ?? false;
  // OS chrome renders in the DEVICE language, not the app locale (§8.3) —
  // when they differ, say so instead of misdirecting a mis-tap-prone user.
  const osLangDiffers =
    typeof navigator !== "undefined" &&
    !!navigator.language &&
    navigator.language.slice(0, 2).toLowerCase() !== locale.slice(0, 2).toLowerCase();

  return (
    <section className="card p-5" aria-labelledby="notify-title" data-testid="notifications-card">
      <h2 id="notify-title" className="text-lg font-bold">
        {t("card.title")}
      </h2>
      {/* §8.3/§8.8: the ONE taught undo opens the card, verbatim in the soft-ask too. */}
      <p className="mt-1 text-xs text-stone-500">{t("card.undo")}</p>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      {/* §8.3 step 0 capability states — never a dead toggle. */}
      {capability === "embedded" && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-semibold">{t("embedded.title")}</p>
          <p className="mt-1 text-stone-600">{t("embedded.body")}</p>
          <button type="button" className="btn-secondary mt-2" onClick={() => void copyLink()}>
            {copied ? t("embedded.copied") : t("embedded.copyLink")}
          </button>
        </div>
      )}
      {capability === "ios-old" && (
        <p className="mt-3 rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm text-stone-600">
          {t("iosOld.body")}
        </p>
      )}
      {capability === "unsupported" && (
        <p className="mt-3 rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm text-stone-600">
          {t("unsupported.body")}
        </p>
      )}

      {/* §8.4 iOS onboarding step 1: install education, in Safari. */}
      {capability === "ios-install" && (
        <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm" data-testid="ios-install">
          <p className="font-semibold">{t("iosInstall.title")}</p>
          <ol className="mt-2 space-y-1 text-stone-700">
            <li>{t("iosInstall.step1")}</li>
            <li>{t("iosInstall.step2")}</li>
            <li>{t("iosInstall.step3")}</li>
          </ol>
          <p className="mt-2 text-xs text-stone-500">{t("iosInstall.note")}</p>
          {!installMarked ? (
            <button type="button" className="btn-primary mt-2" onClick={() => void markInstalled()}>
              {t("iosInstall.started")}
            </button>
          ) : (
            <p className="mt-2 text-xs font-semibold text-emerald-700" role="status">
              {t("iosInstall.marked")}
            </p>
          )}
        </div>
      )}

      {/* §8.3 step 3: denied is a lost cause per-browser — say the true recovery. */}
      {permissionDenied && capability === "ok" && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-semibold">{t("denied.title")}</p>
          <p className="mt-1 text-stone-600">{isStandaloneIos() ? t("denied.ios") : t("denied.desktop")}</p>
        </div>
      )}

      {/* Master state + this-device action. */}
      {capability === "ok" && !permissionDenied && (
        <div className="mt-3">
          {!enabled ? (
            <button
              type="button"
              className="btn-primary"
              disabled={busyKey === "enable" || !user}
              onClick={() => setSoftAskOpen(true)}
              data-testid="notify-enable"
            >
              {t("card.enable")}
            </button>
          ) : thisDeviceLive ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-emerald-700" role="status">
                {t("card.thisDeviceOn")}
              </p>
              <button
                type="button"
                className="btn-secondary"
                disabled={busyKey === "device"}
                onClick={() => void turnOffThisDevice()}
                data-testid="notify-device-off"
              >
                {t("card.thisDeviceOff")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={busyKey === "enable"}
              onClick={() => setSoftAskOpen(true)}
              data-testid="notify-device-on"
            >
              {t("card.thisDeviceEnable")}
            </button>
          )}
        </div>
      )}

      {enabled && (
        <>
          {/* §8.7: zero-device truth at account level. */}
          {devices.length === 0 && (
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm" role="status">
              {t("card.noDevices")}
            </p>
          )}

          <h3 className="mt-4 text-sm font-bold">{t("categories.title")}</h3>
          <div className="mt-2 space-y-2">
            {/* §8.2: a category renders only where it can ever fire. */}
            {duties?.approvals && user && (
              <CategoryRow
                id="notifySigning"
                name={t("categories.signing.name")}
                example={t("categories.signing.example")}
                on={user.notifySigning}
                busy={busyKey === "notifySigning"}
                onToggle={(k, n) => void onToggleCategory(k, n)}
                t={t}
              />
            )}
            {user && (
              <CategoryRow
                id="notifyClaimProgress"
                name={t("categories.claims.name")}
                example={t("categories.claims.example")}
                on={user.notifyClaimProgress}
                busy={busyKey === "notifyClaimProgress"}
                onToggle={(k, n) => void onToggleCategory(k, n)}
                t={t}
              />
            )}
            {duties?.finance && user && (
              <CategoryRow
                id="notifyFinance"
                name={t("categories.finance.name")}
                example={t("categories.finance.example")}
                on={user.notifyFinance}
                busy={busyKey === "notifyFinance"}
                onToggle={(k, n) => void onToggleCategory(k, n)}
                t={t}
              />
            )}
            {user && (
              <CategoryRow
                id="notifySecurity"
                name={t("categories.security.name")}
                example={t("categories.security.example")}
                on={user.notifySecurity}
                busy={busyKey === "notifySecurity"}
                onToggle={(k, n) => void onToggleCategory(k, n)}
                t={t}
              />
            )}
            {user && (
              <CategoryRow
                id="notifyDiscreet"
                name={t("categories.discreet.name")}
                example={t("categories.discreet.example")}
                on={user.notifyDiscreet}
                busy={busyKey === "notifyDiscreet"}
                onToggle={(k, n) => void onToggleCategory(k, n)}
                t={t}
              />
            )}
          </div>

          {devices.length > 0 && (
            <>
              <h3 className="mt-4 text-sm font-bold">{t("card.devices")}</h3>
              <ul className="mt-2 space-y-1">
                {devices.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 p-2 text-sm"
                  >
                    <span>
                      {d.label || t("card.deviceUnnamed")}
                      {d.current && (
                        <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-xs font-semibold text-indigo-700">
                          {t("card.deviceCurrent")}
                        </span>
                      )}
                      <span className="ml-2 text-xs text-stone-400">
                        {format.dateTime(new Date(d.lastSeenAt), { dateStyle: "medium" })}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busyKey === `remove-${d.id}`}
                      onClick={() => void removeDevice(d.id)}
                      aria-label={t("card.deviceRemoveAria", { label: d.label || t("card.deviceUnnamed") })}
                    >
                      {t("card.deviceRemove")}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={busyKey === "selftest"}
              onClick={() => void sendSelfTest()}
              data-testid="notify-self-test"
            >
              {t("card.selfTest")}
            </button>
            {selfTestAt && (
              <span className="text-sm text-stone-600" role="status">
                {t("card.selfTestSent", { time: selfTestAt })}
              </span>
            )}
          </div>

          <div className="mt-4 border-t border-stone-100 pt-3">
            <button
              type="button"
              className="btn-danger"
              disabled={busyKey === "master"}
              onClick={() => void turnAllOff()}
              data-testid="notify-all-off"
            >
              {t("card.accountOff")}
            </button>
          </div>
        </>
      )}

      {/* §8.3 soft-ask: our dialog first; the native prompt only after. */}
      {softAskOpen && (
        <div
          ref={dialogRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal
          aria-label={t("softAsk.title")}
        >
          <div className="card max-h-[85dvh] w-full max-w-md overflow-y-auto p-6" data-testid="notify-soft-ask">
            <h3 className="text-lg font-bold">{t("softAsk.title")}</h3>
            <p className="mt-2 text-sm">{t("softAsk.body")}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-stone-600">
              {duties?.approvals && <li>{t("categories.signing.example")}</li>}
              <li>{t("categories.claims.example")}</li>
              {duties?.finance && <li>{t("categories.finance.example")}</li>}
              <li>{t("categories.security.example")}</li>
            </ul>
            {/* §8.3: say the quiet parts out loud. */}
            <p className="mt-3 text-xs text-stone-500">{t("softAsk.privacy")}</p>
            {(duties?.approvals || duties?.finance) && (
              <p className="mt-1 text-xs text-stone-500">{t("softAsk.noDuty")}</p>
            )}
            {duties?.approvals && <p className="mt-1 text-xs text-stone-500">{t("softAsk.reassign")}</p>}
            <p className="mt-1 text-xs text-stone-500">{t("softAsk.shared")}</p>
            {!pushConfig.mock && (
              <p className="mt-3 rounded-lg bg-indigo-50 p-2 text-xs text-indigo-900">
                {t("softAsk.promptHint")}
                {osLangDiffers && <> {t("softAsk.promptHintOs")}</>}
              </p>
            )}
            <p className="mt-3 text-xs font-semibold">{t("card.undo")}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setSoftAskOpen(false)}>
                {t("softAsk.decline")}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busyKey === "enable"}
                onClick={() => void confirmSoftAsk()}
                data-testid="notify-soft-ask-confirm"
              >
                {busyKey === "enable" ? "…" : t("softAsk.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function isStandaloneIos(): boolean {
  if (typeof window === "undefined") return false;
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  return standalone && /iPhone|iPad|iPod/.test(navigator.userAgent);
}
