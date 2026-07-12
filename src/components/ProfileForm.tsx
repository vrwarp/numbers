"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

interface Profile {
  email: string;
  fullName: string | null;
  mailingAddress: string | null;
}

export default function ProfileForm() {
  const t = useTranslations("Profile");
  const tCommon = useTranslations("Common");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [fullName, setFullName] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
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
      body: JSON.stringify({ fullName, mailingAddress }),
    });
    if (res.ok) setSaved(true);
    else setError((await res.json()).error ?? t("saveFailed"));
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
