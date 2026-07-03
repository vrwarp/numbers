import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import { isAuthTestMode } from "@/lib/config";
import { firebaseWebConfig } from "@/lib/firebase-admin";
import SignInCard from "@/components/SignInCard";

export default async function SignInPage() {
  if (await currentUserId()) redirect("/");

  return (
    <div className="mx-auto mt-16 max-w-md">
      <div className="card p-8 text-center">
        <div className="text-5xl" aria-hidden>
          ⛪
        </div>
        <h1 className="mt-3 text-2xl font-bold text-indigo-700">Numbers</h1>
        <p className="mt-1 text-sm text-stone-500">
          CFCC expense reimbursements — snap receipts now, file the claim later.
        </p>

        <SignInCard firebaseConfig={firebaseWebConfig()} testMode={isAuthTestMode()} />
      </div>
    </div>
  );
}
