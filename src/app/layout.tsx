import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import "./globals.css";
import { currentUser } from "@/auth";
import { isAppAdmin } from "@/lib/config";
import { canViewMembers } from "@/lib/members-guard";
import { embeddingEnabled } from "@/lib/embeddings/settings";
import NavBar from "@/components/NavBar";
import DeviceRequestsBanner from "@/components/esign/DeviceRequestsBanner";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Meta");
  return {
    title: t("title"),
    description: t("description"),
    manifest: "/manifest.webmanifest",
    icons: {
      icon: "/icon-192.png",
      apple: "/apple-touch-icon.png",
    },
    appleWebApp: { capable: true, title: t("appName"), statusBarStyle: "default" },
  };
}

export const viewport: Viewport = {
  themeColor: "#4f46e5",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Required for env(safe-area-inset-*) to resolve on iOS — without it the
  // claim bar's home-indicator padding (Shoebox bottom dock) computes to 0
  // in the installed home-screen app.
  viewportFit: "cover",
  // Resize the layout viewport when the on-screen keyboard opens (instead of
  // letting it cover fixed footers), so a dialog's pinned Save/Confirm stays
  // reachable while an input is focused. dvh units below rely on this.
  interactiveWidget: "resizes-content",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [user, locale, messages, searchEnabled] = await Promise.all([
    currentUser(),
    getLocale(),
    getMessages(),
    embeddingEnabled().catch(() => false),
  ]);
  return (
    <html lang={locale}>
      <body className="min-h-screen">
        <NextIntlClientProvider locale={locale} messages={messages}>
          {user && (
            <NavBar
              userName={user.fullName ?? user.email}
              isAdmin={isAppAdmin(user)}
              canManageMinistries={user.role === "treasurer" || isAppAdmin(user)}
              canViewMembers={canViewMembers(user)}
              searchEnabled={searchEnabled}
            />
          )}
          {user && <DeviceRequestsBanner />}
          <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
