"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useBackDismiss } from "./use-back-dismiss";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Baseline modal dismissal for the app's hand-rolled dialogs: Escape closes,
 * the platform back gesture closes (see `useBackDismiss`), Tab cycles inside
 * the container, initial focus lands on the first focusable element (deferring
 * to an `autoFocus` field), and focus returns to the opener on unmount.
 * Keyboard listeners live on the container — not `document` — so stacked
 * dialogs each handle only their own keys.
 *
 * Deliberately NOT a full aria-hidden inert treatment: these dialogs are
 * short-lived and the trap covers the practical keyboard/AT paths.
 */
export function useModalDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  /** For dialogs that render closed (e.g. `open` prop) — hooks can't be
   *  conditional, so the enablement is. */
  enabled = true
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Back gesture / hardware back dismisses the dialog like Escape does.
  useBackDismiss(onClose, enabled);

  useEffect(() => {
    if (!enabled) return;
    const node = ref.current;
    if (!node) return;
    const opener = document.activeElement as HTMLElement | null;
    if (!node.contains(document.activeElement)) {
      const first =
        node.querySelector<HTMLElement>("[autofocus]") ??
        node.querySelector<HTMLElement>(FOCUSABLE) ??
        node;
      first.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = Array.from(node!.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !node!.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !node!.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }

    node.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      // The opener may have unmounted with the dialog (e.g. a row action) —
      // focus() on a detached node is a harmless no-op.
      opener?.focus?.();
    };
  }, [ref, enabled]);
}
