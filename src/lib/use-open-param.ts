"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * THE app-wide deep-link contract (docs/SEARCH_DESIGN.md §7.3, CONVENTIONS
 * "Deep links"): `?open=<id>` lands on a list page, which — once its data is
 * loaded — expands the enclosing section if needed, scrolls the target into
 * view with a ~3 s pulse ring, strips the param from the URL (back/refresh
 * must not re-scroll), and reports a miss so the caller can toast.
 *
 * The target element carries `data-open-id="<id>"`; `beforeScroll` runs first
 * (open a <details>, expand a row) and may need a frame before the node is
 * measurable, so scrolling happens on the next animation frame.
 */
export function useOpenParam(opts: {
  ready: boolean;
  exists: (id: string) => boolean;
  beforeScroll?: (id: string) => void;
  onGone?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const handled = useRef(false);
  const { ready, exists, beforeScroll, onGone } = opts;

  useEffect(() => {
    if (handled.current || !ready) return;
    const id = params.get("open");
    if (!id) return;
    handled.current = true;

    const strip = () => {
      const rest = new URLSearchParams(params.toString());
      rest.delete("open");
      const qs = rest.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    };

    if (!exists(id)) {
      onGone?.();
      strip();
      return;
    }
    beforeScroll?.(id);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-open-id="${CSS.escape(id)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("highlight-pulse");
        setTimeout(() => el.classList.remove("highlight-pulse"), 3000);
      }
      strip();
    });
  }, [ready, params, pathname, router, exists, beforeScroll, onGone]);
}
