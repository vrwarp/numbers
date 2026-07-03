import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { isAuthTestMode } from "@/lib/config";

export default async function SignInPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  const hasGoogle = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const testMode = isAuthTestMode();

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

        {hasGoogle && (
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/" });
            }}
            className="mt-8"
          >
            <button type="submit" className="btn-primary w-full py-3">
              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
                <path
                  fill="currentColor"
                  d="M21.35 11.1H12v2.9h5.3c-.5 2.5-2.6 4.3-5.3 4.3a5.8 5.8 0 1 1 0-11.6c1.5 0 2.8.5 3.8 1.4l2.2-2.2A8.9 8.9 0 0 0 12 3a9 9 0 1 0 0 18c5.2 0 8.9-3.7 8.9-8.9 0-.3 0-.7-.05-1z"
                />
              </svg>
              Sign in with Google
            </button>
          </form>
        )}

        {!hasGoogle && !testMode && (
          <p className="mt-8 rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
            No sign-in method is configured. Set <code>GOOGLE_CLIENT_ID</code> and{" "}
            <code>GOOGLE_CLIENT_SECRET</code> in the environment.
          </p>
        )}

        {testMode && (
          <form
            action={async (formData: FormData) => {
              "use server";
              await signIn("test-login", {
                email: String(formData.get("email") ?? ""),
                name: String(formData.get("name") ?? ""),
                redirectTo: "/",
              });
            }}
            className="mt-8 space-y-3 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-4 text-left"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
              Dev login (test mode)
            </p>
            <input name="email" type="email" required placeholder="you@example.com" className="input" data-testid="dev-email" />
            <input name="name" type="text" placeholder="Your name" className="input" data-testid="dev-name" />
            <button type="submit" className="btn-secondary w-full" data-testid="dev-signin">
              Sign in (dev)
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
