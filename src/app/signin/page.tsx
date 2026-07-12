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
    <div className="mx-auto mt-16 max-w-md">
      <div className="card p-8 text-center">
        <div className="text-5xl" aria-hidden>
          ⛪
        </div>
        <h1 className="mt-3 text-2xl font-bold text-indigo-700">Numbers</h1>
        <p className="mt-1 text-sm text-stone-500">{t("tagline")}</p>

        <SignInCard firebaseConfig={firebaseWebConfig()} testMode={isAuthTestMode()} />
      </div>
      <div className="mt-4 flex justify-center">
        <LocaleSwitcher />
      </div>
    </div>
  );
}
