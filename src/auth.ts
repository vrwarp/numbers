import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { isAuthTestMode } from "@/lib/config";

/**
 * JWT-based sessions with a User row upserted on sign-in. We deliberately skip
 * the database adapter: SQLite holds only our domain User table, tokens live
 * in the cookie, and sign-out needs no server state.
 *
 * AUTH_TEST_MODE=1 adds a passwordless "Dev Login" credentials provider so
 * Playwright (and local dev without Google credentials) can authenticate.
 */

const providers = [];

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    })
  );
}

if (isAuthTestMode()) {
  providers.push(
    Credentials({
      id: "test-login",
      name: "Dev Login",
      credentials: {
        email: { label: "Email", type: "email" },
        name: { label: "Name", type: "text" },
      },
      async authorize(credentials) {
        const email = String(credentials?.email ?? "").trim().toLowerCase();
        if (!email) return null;
        const name = String(credentials?.name ?? "") || email.split("@")[0];
        return { id: email, email, name };
      },
    })
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt" },
  trustHost: true,
  pages: { signIn: "/signin" },
  callbacks: {
    async jwt({ token, account, user }) {
      // On first sign-in, upsert our domain user and pin its id in the token.
      if (user?.email) {
        const googleId = account?.provider === "google" ? account.providerAccountId : undefined;
        const dbUser = await prisma.user.upsert({
          where: { email: user.email },
          update: googleId ? { googleId } : {},
          create: {
            email: user.email,
            fullName: user.name ?? null,
            googleId: googleId ?? null,
          },
        });
        token.userId = dbUser.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.userId) {
        (session.user as { id?: string }).id = token.userId as string;
      }
      return session;
    },
  },
});

/** Resolve the current DB user id, or null if unauthenticated. */
export async function currentUserId(): Promise<string | null> {
  const session = await auth();
  return (session?.user as { id?: string } | undefined)?.id ?? null;
}
