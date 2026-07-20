"use client";

import { type ReactNode } from "react";
import { fetchAndDeliver, isIosStandalonePwa } from "@/lib/pdf-delivery";

/**
 * A link to an AUTHENTICATED file URL (packet, certificate, receipt file).
 * Normal browsers — Android standalone PWAs included — get the plain new-tab
 * anchor, so the server's `Content-Disposition: inline` renders in-tab. In an
 * iOS standalone (home-screen) PWA the new tab is an overlay browser WITHOUT
 * the session cookie — the user would see a sign-in page — so the click is
 * intercepted and the bytes are fetched in-app and delivered via the OS share
 * sheet instead.
 */
export default function PdfLink({
  href,
  filename,
  className,
  children,
  testId,
}: {
  href: string;
  filename: string;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (!isIosStandalonePwa()) return;
        e.preventDefault();
        e.stopPropagation();
        void fetchAndDeliver(href, filename).catch(() => {});
      }}
      data-testid={testId}
    >
      {children}
    </a>
  );
}
