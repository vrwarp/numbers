"use client";

import { useEffect, useRef } from "react";

/**
 * Keep a status surface live without a manual reload: re-run `refresh` on an
 * interval while the tab is visible, and immediately when the tab regains
 * visibility or focus (the moment people actually come back to check).
 *
 * `paused` suspends everything — pass it while a ceremony dialog is open so a
 * background reload never yanks state out from under a signature in progress.
 */
export function useAutoRefresh(
  refresh: () => void,
  { intervalMs = 60_000, paused = false }: { intervalMs?: number; paused?: boolean } = {}
) {
  const cb = useRef(refresh);
  cb.current = refresh;

  useEffect(() => {
    if (paused) return;
    const runIfVisible = () => {
      if (document.visibilityState === "visible") cb.current();
    };
    const id = setInterval(runIfVisible, intervalMs);
    document.addEventListener("visibilitychange", runIfVisible);
    window.addEventListener("focus", runIfVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", runIfVisible);
      window.removeEventListener("focus", runIfVisible);
    };
  }, [intervalMs, paused]);
}
