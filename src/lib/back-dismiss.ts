/**
 * Browser / OS back-gesture coordination for stacked overlays.
 *
 * A modal, full-screen viewer, or slide-over that a mobile user opens should be
 * dismissed by the platform back gesture (Android back button, iOS edge swipe,
 * browser Back) instead of navigating away from the page underneath it. The
 * mechanism: each open surface pushes ONE history entry, and a single shared
 * `popstate` listener closes only the TOPMOST surface — so stacked overlays
 * peel off one back gesture at a time (LIFO).
 *
 * Two hard-won constraints from living inside the Next.js App Router:
 *
 *  1. We push a shallow copy of the CURRENT `history.state` and never write our
 *     own fields into it. The App Router keeps routing bookkeeping there
 *     (`__NA`, `__PRIVATE_NEXTJS_INTERNALS_TREE`); a `null` state makes it treat
 *     the entry as a foreign one (full reload / broken `router.push`), and a
 *     custom object corrupts it. Copying preserves the current tree, so back and
 *     the next navigation both stay on the app router. Our own adoption marker
 *     lives in the module variable `leftoverPath`, never in history state.
 *
 *  2. We NEVER call `history.back()` to "consume" a pushed entry when an
 *     overlay closes by button/Escape: that races any navigation the close
 *     action triggers (a confirm dialog whose action calls `router.push`) — the
 *     browser hasn't committed the navigation yet, so `back()` undoes it. A
 *     button-closed overlay leaves its entry behind and the NEXT overlay opened
 *     on the same URL adopts it (tracked in `leftoverPath`), which bounds
 *     history growth without ever fighting a navigation.
 *
 * The React wrapper is `useBackDismiss` (and, folded in, `useModalDismiss`);
 * this module is the framework-free core so the stack coordination is unit
 * testable without a DOM renderer.
 */

interface Entry {
  close: () => void;
  path: string;
  poppedByBack?: boolean;
}

const stack: Entry[] = [];
let listening = false;
/** Path of the single adoptable top sentinel left by a button-closed overlay,
 *  or null when the top of history is a real page entry. */
let leftoverPath: string | null = null;

function currentPath(): string {
  return window.location.pathname + window.location.search;
}

function onPopState() {
  const top = stack.pop();
  if (top) {
    top.poppedByBack = true;
    top.close();
  } else {
    // A stray back with nothing open consumed a dangling leftover sentinel.
    leftoverPath = null;
  }
}

/**
 * Register an open overlay. Pushes a history entry (or adopts a reusable one)
 * and returns a disposer to call when the overlay closes for ANY reason. Call
 * from a client effect only (touches `window`).
 */
export function pushBackDismiss(close: () => void): () => void {
  if (!listening) {
    window.addEventListener("popstate", onPopState);
    listening = true;
  }
  const path = currentPath();
  const entry: Entry = { close, path };
  const adopt = stack.length === 0 && leftoverPath === path;
  stack.push(entry);
  if (adopt) {
    leftoverPath = null; // the leftover is an active overlay again
  } else {
    // Copy the App Router's current state onto our new entry (see note 1).
    window.history.pushState({ ...window.history.state }, "");
    leftoverPath = null; // our fresh sentinel is on top and active
  }
  return () => {
    const i = stack.indexOf(entry);
    if (i !== -1) stack.splice(i, 1);
    if (stack.length > 0) return;
    // Closing the last overlay: a back gesture already consumed its entry, but
    // a button/Escape close leaves it behind for the next overlay to adopt.
    leftoverPath = entry.poppedByBack ? null : entry.path;
  };
}

/** Test-only: reset module state between cases. */
export function __resetBackDismissForTest() {
  stack.length = 0;
  listening = false;
  leftoverPath = null;
}
