"use client";

import { useTranslations } from "next-intl";

/**
 * Route-level loading fallbacks (`loading.tsx`). Every page is force-dynamic,
 * so client-side navigation waits a full server roundtrip — these paint the
 * destination's rough shape immediately instead of freezing on the old page.
 * Client component on purpose: it renders from the already-loaded bundle with
 * no server work, and useTranslations reads the layout's provider.
 */

function Shimmer({ className }: { className: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded bg-stone-200 motion-reduce:animate-none ${className}`}
    />
  );
}

function Header() {
  return (
    <div className="space-y-2">
      <Shimmer className="h-7 w-40" />
      <Shimmer className="h-4 w-64 max-w-full" />
    </div>
  );
}

function Status({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Common");
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">{t("loading")}</span>
      {children}
    </div>
  );
}

/** Generic fallback (root loading.tsx): header + a card grid, which reads as
 *  "content coming" for both the Shoebox photo grid and the client-shell
 *  pages (approvals, finance, admin, …). */
export function PageSkeleton() {
  return (
    <Status>
      <Header />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="card overflow-hidden">
            <Shimmer className="h-36 w-full rounded-none" />
            <div className="space-y-2 p-2">
              <Shimmer className="h-3 w-3/4" />
              <Shimmer className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </Status>
  );
}

/** Row-list fallback (claims list). */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Status>
      <Header />
      <div className="space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="card flex items-center justify-between p-4">
            <div className="space-y-2">
              <Shimmer className="h-5 w-36" />
              <Shimmer className="h-4 w-24" />
            </div>
            <Shimmer className="h-6 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </Status>
  );
}

/** Review-screen fallback: receipt panel beside line-item rows. */
export function ReviewSkeleton() {
  return (
    <Status>
      <Header />
      <div className="card space-y-4 p-4">
        <div className="flex gap-4">
          <Shimmer className="h-40 w-32 shrink-0" />
          <div className="flex-1 space-y-3">
            <Shimmer className="h-5 w-1/2" />
            <Shimmer className="h-4 w-1/3" />
            <Shimmer className="h-10 w-full" />
          </div>
        </div>
        <Shimmer className="h-10 w-full" />
        <Shimmer className="h-10 w-full" />
      </div>
    </Status>
  );
}
