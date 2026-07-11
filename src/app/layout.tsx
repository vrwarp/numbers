import type { Metadata, Viewport } from "next";
import "./globals.css";
import { currentUser } from "@/auth";
import NavBar from "@/components/NavBar";
import DeviceRequestsBanner from "@/components/esign/DeviceRequestsBanner";

export const metadata: Metadata = {
  title: "Numbers — CFCC Reimbursements",
  description: "Snap church receipts now, submit reimbursement claims later.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: { capable: true, title: "Numbers", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#4f46e5",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body className="min-h-screen">
        {user && <NavBar userName={user.fullName ?? user.email} />}
        {user && <DeviceRequestsBanner />}
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
