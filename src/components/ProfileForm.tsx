"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { LOCALES, LOCALE_LABELS } from "@/lib/locales";
import { signOut } from "@/lib/sign-out";
import { useApiErrorMessage } from "@/lib/use-api-error";

interface Profile {
  email: string;
  fullName: string | null;
  mailingAddress: string | null;
  locale: string;
  approvalsPaused: boolean;
  financePaused: boolean;
  adminPaused: boolean;
}

/** Which duty toggles this member's grants make relevant (server-computed:
 *  approver-or-above / treasurer-or-admin / app-admin incl. ADMIN_EMAILS). */
interface Duties {
  approvals: boolean;
  finance: boolean;
  admin: boolean;
}

const DUTY_FLAGS = ["approvalsPaused", "financePaused", "adminPaused"] as const;
type DutyFlag = (typeof DUTY_FLAGS)[number];

/** One duty on/off row — same idiom as the e-sign master switch card. */
function DutyRow({
  flag,
  paused,
  title,
  body,
  busy,
  onLabel,
  offLabel,
  onToggle,
}: {
  flag: DutyFlag;
  paused: boolean;
  title: string;
  body: string;
  busy: boolean;
  onLabel: string;
  offLabel: string;
  onToggle: (flag: DutyFlag, paused: boolean) => Promise<void>;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${
        paused ? "border-stone-200 bg-stone-50" : "border-emerald-200 bg-emerald-50"
      }`}
      data-testid={`duty-${flag}`}
    >
      <div className="text-sm">
        <p className="font-semibold">{title}</p>
        <p className="text-xs text-stone-500">{body}</p>
      </div>
      <button
        type="button"
        // shrink-0 + whitespace-nowrap: the neighbouring description varies in
        // length per row, and without these the flex row squeezes the button
        // until "Turn off" wraps unevenly. min-w keeps all rows' buttons the
        // same width even when some read "Turn on" and others "Turn off".
        className={`min-w-24 shrink-0 whitespace-nowrap ${paused ? "btn-primary" : "btn-secondary"}`}
        disabled={busy}
        onClick={() => void onToggle(flag, !paused)}
        data-testid={`duty-${flag}-toggle`}
      >
        {busy ? "…" : paused ? onLabel : offLabel}
      </button>
    </div>
  );
}

export default function ProfileForm() {
  const t = useTranslations("Profile");
  const tCommon = useTranslations("Common");
  const router = useRouter();
  const activeLocale = useLocale();
  const apiError = useApiErrorMessage();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [duties, setDuties] = useState<Duties | null>(null);
  // Active teams this member belongs to — surfacing the read grant they'd
  // otherwise never learn about (it only manifests as a Search scope).
  const [teams, setTeams] = useState<string[]>([]);
  const [fullName, setFullName] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
  const [locale, setLocale] = useState<string>(activeLocale);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dutyBusy, setDutyBusy] = useState<DutyFlag | null>(null);
  const [dutyError, setDutyError] = useState<string | null>(null);
  // "?return=<path>" sends the user back to where the missing profile blocked
  // them (the claim review banner links here). Same-origin paths only.
  const [returnTo, setReturnTo] = useState<string | null>(null);

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("return");
    if (raw && raw.startsWith("/") && !raw.startsWith("//")) setReturnTo(raw);
  }, []);

  useEffect(() => {
    fetch("/api/profile")
      .then((r) => r.json())
      .then(({ user, duties, teams }) => {
        setProfile(user);
        setDuties(duties ?? null);
        setTeams(Array.isArray(teams) ? teams : []);
        setFullName(user.fullName ?? "");
        setMailingAddress(user.mailingAddress ?? "");
        setLocale(user.locale ?? "en");
      })
      .catch(() => setError(t("loadFailed")));
  }, []);

  /** Duty pauses save immediately — they change what other members see. */
  async function toggleDuty(flag: DutyFlag, paused: boolean) {
    if (!profile) return;
    setDutyBusy(flag);
    setDutyError(null);
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [flag]: paused }),
    });
    if (res.ok) {
      const { user, duties } = await res.json();
      setProfile(user);
      setDuties(duties ?? null);
    } else {
      setDutyError(apiError(await res.json().catch(() => null), t("saveFailed")));
    }
    setDutyBusy(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName, mailingAddress, locale }),
    });
    if (res.ok) {
      setSaved(true);
      // Close the loop for users sent here mid-task (e.g. the claim review's
      // profile banner) — but only once the form actually satisfies it.
      if (returnTo && fullName.trim() && mailingAddress.trim()) {
        router.push(returnTo);
        return;
      }
      // The route also set the locale cookie — re-render in the new language.
      if (locale !== activeLocale) router.refresh();
    } else {
      setError(apiError(await res.json().catch(() => null), t("saveFailed")));
    }
    setBusy(false);
  }

  if (!profile) return <p className="text-sm text-stone-500">{error ?? tCommon("loading")}</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="keyboard-smooth text-2xl font-bold short:text-lg">{t("title")}</h1>
        <div className="collapse-short">
          <p className="text-sm text-stone-500">{t("subtitle")}</p>
        </div>
      </div>
      <form onSubmit={save} className="card space-y-4 p-6">
        <div>
          <label className="text-sm font-medium">{t("email")}</label>
          <input className="input mt-1 bg-stone-50" value={profile.email} disabled />
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="fullName">
            {t("fullName")}
          </label>
          <input
            id="fullName"
            className="input mt-1"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder={t("fullNamePlaceholder")}
            data-testid="profile-name"
          />
          {!fullName.trim() && (
            <p className="mt-1 text-xs text-amber-700">{t("printedOnForm")}</p>
          )}
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="mailingAddress">
            {t("mailingAddress")}
          </label>
          <textarea
            id="mailingAddress"
            className="input mt-1"
            rows={2}
            value={mailingAddress}
            onChange={(e) => setMailingAddress(e.target.value)}
            placeholder={t("mailingAddressPlaceholder")}
            data-testid="profile-address"
          />
          {!mailingAddress.trim() && (
            <p className="mt-1 text-xs text-amber-700">{t("printedOnForm")}</p>
          )}
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="locale">
            {tCommon("language")}
          </label>
          <select
            id="locale"
            className="input mt-1"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
            data-testid="profile-locale"
          >
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {LOCALE_LABELS[l]}
              </option>
            ))}
          </select>
        </div>
        {/* On a short viewport the form runs past the fold with the keyboard up,
            so Save pins to the bottom edge (bleeding past the card's p-6). The
            "Saved ✓" / error feedback sits in the same row, where the tap is. */}
        <div className="z-10 flex items-center gap-3 short:sticky short:bottom-0 short:-mx-6 short:-mb-6 short:border-t short:border-stone-200 short:bg-white/95 short:px-6 short:py-3 short:pb-[calc(0.75rem+env(safe-area-inset-bottom))] short:backdrop-blur">
          <button type="submit" className="btn-primary" disabled={busy} data-testid="profile-save">
            {busy ? tCommon("saving") : tCommon("save")}
          </button>
          {saved && <span className="text-sm font-medium text-emerald-700">{t("saved")}</span>}
          {error && <span className="text-sm text-red-700">{error}</span>}
        </div>
      </form>
      {/* Duty pauses (A10): role-holders step back without a role change —
          paused members drop out of pickers/queues; the roster is untouched. */}
      {duties && (duties.approvals || duties.finance || duties.admin) && (
        <div className="card space-y-3 p-6" data-testid="duties-card">
          <div>
            <h2 className="font-semibold">{t("dutiesTitle")}</h2>
            <p className="text-sm text-stone-500">{t("dutiesNote")}</p>
          </div>
          {duties.approvals && (
            <DutyRow
              flag="approvalsPaused"
              paused={profile.approvalsPaused}
              title={t("dutyApprovalsTitle")}
              body={profile.approvalsPaused ? t("dutyApprovalsOff") : t("dutyApprovalsOn")}
              busy={dutyBusy === "approvalsPaused"}
              onLabel={t("dutyTurnOn")}
              offLabel={t("dutyTurnOff")}
              onToggle={toggleDuty}
            />
          )}
          {duties.finance && (
            <DutyRow
              flag="financePaused"
              paused={profile.financePaused}
              title={t("dutyFinanceTitle")}
              body={profile.financePaused ? t("dutyFinanceOff") : t("dutyFinanceOn")}
              busy={dutyBusy === "financePaused"}
              onLabel={t("dutyTurnOn")}
              offLabel={t("dutyTurnOff")}
              onToggle={toggleDuty}
            />
          )}
          {duties.admin && (
            <DutyRow
              flag="adminPaused"
              paused={profile.adminPaused}
              title={t("dutyAdminTitle")}
              body={profile.adminPaused ? t("dutyAdminOff") : t("dutyAdminOn")}
              busy={dutyBusy === "adminPaused"}
              onLabel={t("dutyTurnOn")}
              offLabel={t("dutyTurnOff")}
              onToggle={toggleDuty}
            />
          )}
          {dutyError && <p className="text-sm text-red-700">{dutyError}</p>}
        </div>
      )}

      {teams.length > 0 && (
        <div className="card space-y-1 p-6" data-testid="profile-teams-card">
          <h2 className="font-semibold">{t("teamsTitle")}</h2>
          <p className="text-sm text-stone-600">{teams.join(", ")}</p>
          <p className="text-sm text-stone-500">
            {t.rich("teamsBody", {
              link: (chunks) => (
                <a href="/search?scope=team" className="text-indigo-600 underline">
                  {chunks}
                </a>
              ),
            })}
          </p>
        </div>
      )}

    </div>
  );
}

/** The NavBar's sign-out is hidden on phone widths — this is its mobile home.
 *  Rendered by the profile PAGE after the signing card, so the page's terminal
 *  action really is terminal (every e-sign nudge deep-links to the card; the
 *  card must not sit below a button that reads as end-of-page). */
export function MobileSignOut() {
  const tNav = useTranslations("NavBar");
  return (
    <div className="flex justify-center sm:hidden">
      <button
        type="button"
        className="btn-secondary"
        onClick={() => signOut()}
        data-testid="profile-sign-out"
      >
        {tNav("signOut")}
      </button>
    </div>
  );
}
