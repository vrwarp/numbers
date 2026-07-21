"use client";

import { useEffect, useRef } from "react";
import { pushBackDismiss } from "./back-dismiss";

/**
 * Close `onClose` when the platform back gesture / hardware back fires, instead
 * of navigating away from the page. Push one history entry while `enabled`;
 * stacked overlays each own an entry and peel off one back at a time (see
 * `back-dismiss.ts`). `enabled` gates dialogs that render while closed (an
 * `open` prop) — hooks can't be conditional, so the enablement is.
 */
export function useBackDismiss(onClose: () => void, enabled = true) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    return pushBackDismiss(() => closeRef.current());
  }, [enabled]);
}
