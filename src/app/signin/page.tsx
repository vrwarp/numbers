import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { currentUserId } from "@/auth";
import { isAuthTestMode } from "@/lib/config";
import { firebaseWebConfig } from "@/lib/firebase-admin";
import SignInCard from "@/components/SignInCard";
import LocaleSwitcher from "@/components/LocaleSwitcher";

export default async function SignInPage() {
  if (await currentUserId()) redirect("/");
  const t = await getTranslations("SignIn");

  return (
    <div className="mx-auto mt-16 max-w-md short:mt-4">
      <div className="card p-8 text-center short:p-5">
        {/* Sign-in is a once-per-device screen, so the brand hero compresses
            (not disappears) on a short viewport to pull the controls up. */}
        <div className="keyboard-smooth text-5xl short:text-3xl" aria-hidden>
          ⛪
        </div>
        <h1 className="keyboard-smooth mt-3 text-2xl font-bold text-indigo-700 short:mt-1 short:text-xl">Numbers</h1>
        <div className="collapse-short">
          <p className="pt-1 text-sm text-stone-500">{t("tagline")}</p>
        </div>

        <SignInCard firebaseConfig={firebaseWebConfig()} testMode={isAuthTestMode()} />
      </div>
      <div className="mt-4 flex items-center justify-center gap-1 text-stone-400">
        <span aria-hidden className="text-sm">
          🌐
        </span>
        <LocaleSwitcher />
      </div>
    </div>
  );
}
