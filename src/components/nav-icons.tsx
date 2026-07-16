/**
 * Small line icons for the nav tabs. They carry the tab's identity so an
 * icon-only tab (narrow widths — see NavTabs / nav-overflow) is still
 * recognizable. Decorative: the accessible name always comes from the adjacent
 * (sometimes sr-only) label, so every icon is aria-hidden at the call site.
 */
import type { SVGProps } from "react";

function Base(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[1.15rem] w-[1.15rem] shrink-0"
      aria-hidden
      {...props}
    />
  );
}

/** Receipts (the Shoebox) — a receipt with a torn edge and text lines. */
export function ReceiptsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M6 3.5h12v17l-2-1.2-2 1.2-2-1.2-2 1.2-2-1.2-2 1.2V3.5Z" />
      <path d="M9 8h6M9 11.5h6M9 15h4" />
    </Base>
  );
}

/** Claims — a folder collecting receipts. */
export function ClaimsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h3.8a1.5 1.5 0 0 1 1.06.44L11 7.5h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" />
    </Base>
  );
}

/** Approvals — a clipboard with a check. */
export function ApprovalsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="8.5" y="3" width="7" height="3.2" rx="1" />
      <path d="M8.5 4.6H6.5A1.5 1.5 0 0 0 5 6.1v13A1.5 1.5 0 0 0 6.5 20.6h11a1.5 1.5 0 0 0 1.5-1.5v-13a1.5 1.5 0 0 0-1.5-1.5h-2" />
      <path d="m9 13 2 2 4-4.5" />
    </Base>
  );
}

/** Finance — a banknote. */
export function FinanceIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="3.5" y="6.5" width="17" height="11" rx="1.5" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M6.5 9.75v4.5M17.5 9.75v4.5" />
    </Base>
  );
}

/** More — overflowed tabs live behind this. Filled dots read at small sizes. */
export function MoreIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className="h-[1.15rem] w-[1.15rem] shrink-0"
      aria-hidden
      {...props}
    >
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}
