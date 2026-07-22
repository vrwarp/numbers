import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTimeZone, getTranslations } from "next-intl/server";
import "./globals.css";
import { currentUser } from "@/auth";
import { isAppAdmin } from "@/lib/config";
import { isCanary, CANARY_THEME_COLOR, DEFAULT_THEME_COLOR } from "@/lib/brand/canary";
import { canManageMinistries } from "@/lib/ministries-guard";
import { canViewMembers } from "@/lib/members-guard";
import { canManageTeams } from "@/lib/teams-guard";
import { embeddingEnabled } from "@/lib/embeddings/settings";
import { pushWebConfig } from "@/lib/notifications/settings";
import { parseUiState } from "@/lib/notifications/ui-state";
import { configValue } from "@/lib/config-file";
import NavBar from "@/components/NavBar";
import DeviceRequestsBanner from "@/components/esign/DeviceRequestsBanner";
import NotificationsRuntime from "@/components/notifications/NotificationsRuntime";
import FeedbackRuntime from "@/components/feedback/FeedbackRuntime";

export async function generateMetadata(): Promise<Metadata> {
  const [t, tb] = await Promise.all([getTranslations("Meta"), getTranslations("Brand")]);
  const base = t("title");
  return {
    // Canary instances prefix the browser-tab title so the marker rides along
    // wherever the page is bookmarked or shows up in a tab strip.
    title: isCanary() ? `${tb("canary")} · ${base}` : base,
    description: t("description"),
    manifest: "/manifest.webmanifest",
    icons: {
      icon: "/icon-192.png",
      apple: "/apple-touch-icon.png",
    },
    appleWebApp: { capable: true, title: t("appName"), statusBarStyle: "default" },
  };
}

export function generateViewport(): Viewport {
  return {
  // Canary repaints the browser chrome / PWA theme color amber.
  themeColor: isCanary() ? CANARY_THEME_COLOR : DEFAULT_THEME_COLOR,
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
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [user, locale, messages, timeZone, searchEnabled] = await Promise.all([
    currentUser(),
    getLocale(),
    getMessages(),
    getTimeZone(),
    embeddingEnabled().catch(() => false),
  ]);
  return (
    <html lang={locale}>
      <body className="min-h-screen">
        <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone}>
          {user && (
            <NavBar
              userName={user.fullName ?? user.email}
              isAdmin={isAppAdmin(user)}
              canManageMinistries={canManageMinistries(user)}
              canViewMembers={canViewMembers(user)}
              canManageTeams={canManageTeams(user)}
              searchEnabled={searchEnabled}
              canary={isCanary()}
            />
          )}
          {user && <DeviceRequestsBanner />}
          {user && (
            <NotificationsRuntime
              pushConfig={pushWebConfig()}
              notifyEnabled={user.notifyEnabled}
              onboardingStep={parseUiState(user.notifyUiStateJson).onboardingStep}
            />
          )}
          {user && <FeedbackRuntime buildSha={configValue("BUILD_SHA") ?? ""} />}
          <main className="mx-auto max-w-6xl py-6 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
