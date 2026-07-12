"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { LOCALES, LOCALE_LABELS } from "@/lib/locales";
import { useApiErrorMessage } from "@/lib/use-api-error";

interface Profile {
  email: string;
  fullName: string | null;
  mailingAddress: string | null;
  locale: string;
}

export default function ProfileForm() {
  const t = useTranslations("Profile");
  const tCommon = useTranslations("Common");
  const router = useRouter();
  const activeLocale = useLocale();
  const apiError = useApiErrorMessage();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [fullName, setFullName] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
  const [locale, setLocale] = useState<string>(activeLocale);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/profile")
      .then((r) => r.json())
      .then(({ user }) => {
        setProfile(user);
        setFullName(user.fullName ?? "");
        setMailingAddress(user.mailingAddress ?? "");
        setLocale(user.locale ?? "en");
      })
      .catch(() => setError(t("loadFailed")));
  }, []);

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
      // The route also set the locale cookie — re-render in the new language.
      if (locale !== activeLocale) router.refresh();
    } else {
      setError(apiError(await res.json().catch(() => null), t("saveFailed")));
    }
    setBusy(false);
  }

  if (!profile) return <p className="text-sm text-stone-500">{error ?? tCommon("loading")}</p>;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-stone-500">{t("subtitle")}</p>
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
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary" disabled={busy} data-testid="profile-save">
            {busy ? tCommon("saving") : tCommon("save")}
          </button>
          {saved && <span className="text-sm font-medium text-emerald-700">{t("saved")}</span>}
          {error && <span className="text-sm text-red-700">{error}</span>}
        </div>
      </form>
    </div>
  );
}
