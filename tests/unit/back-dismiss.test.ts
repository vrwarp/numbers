import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushBackDismiss, __resetBackDismissForTest } from "@/lib/back-dismiss";

// A minimal History + event target standing in for `window`, enough to exercise
// the LIFO coordination. `pushCount`/`backCount` let tests assert that entries
// are adopted (not re-pushed) and that we NEVER call history.back(). We push
// with a null state (the App Router owns history.state), so tests don't read it.
function makeFakeWindow() {
  let depth = 1;
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  let backCount = 0;
  let pushCount = 0;
  const location = { pathname: "/", search: "" };
  const fire = () => {
    for (const fn of listeners.popstate ?? []) fn({ state: null });
  };
  return {
    backCount: () => backCount,
    pushCount: () => pushCount,
    navigateTo(pathname: string) {
      location.pathname = pathname;
    },
    userBack() {
      if (depth > 1) {
        depth--;
        fire();
      }
    },
    win: {
      location,
      history: {
        state: null,
        pushState() {
          pushCount++;
          depth++;
        },
        back() {
          backCount++;
          if (depth > 1) {
            depth--;
            fire();
          }
        },
      },
      addEventListener(type: string, fn: (e: unknown) => void) {
        (listeners[type] ??= []).push(fn);
      },
      removeEventListener(type: string, fn: (e: unknown) => void) {
        listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
      },
    },
  };
}

let fake: ReturnType<typeof makeFakeWindow>;

beforeEach(() => {
  __resetBackDismissForTest();
  fake = makeFakeWindow();
  (globalThis as { window?: unknown }).window = fake.win;
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("pushBackDismiss", () => {
  it("pushes one history entry when a surface opens", () => {
    pushBackDismiss(() => {});
    expect(fake.pushCount()).toBe(1);
  });

  it("closes the surface on the back gesture", () => {
    const close = vi.fn();
    pushBackDismiss(close);
    fake.userBack();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("dismisses only the topmost surface, one back at a time (LIFO)", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    pushBackDismiss(closeA);
    pushBackDismiss(closeB);
    expect(fake.pushCount()).toBe(2);

    fake.userBack();
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();

    fake.userBack();
    expect(closeA).toHaveBeenCalledTimes(1);
  });

  it("never calls history.back() — a button close must not fight a navigation", () => {
    const dispose = pushBackDismiss(() => {});
    dispose();
    expect(fake.backCount()).toBe(0);
  });

  it("adopts a same-URL leftover entry on the next open instead of stacking a new one", () => {
    // First overlay opens then closes via a button (its entry lingers).
    pushBackDismiss(() => {})();
    expect(fake.pushCount()).toBe(1);

    // A second overlay on the same URL reuses that entry — no growth.
    const close = vi.fn();
    pushBackDismiss(close);
    expect(fake.pushCount()).toBe(1);

    // ...and the back gesture still closes it.
    fake.userBack();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not adopt across a navigation — a different URL pushes a fresh entry", () => {
    pushBackDismiss(() => {})();
    expect(fake.pushCount()).toBe(1);

    fake.navigateTo("/elsewhere");
    pushBackDismiss(() => {});
    expect(fake.pushCount()).toBe(2);
  });

  it("does not adopt a leftover consumed by the back gesture", () => {
    // Open then dismiss via back — the entry is gone, not a leftover.
    const close = vi.fn();
    pushBackDismiss(close);
    fake.userBack();
    expect(close).toHaveBeenCalledTimes(1);

    // The next open must push a fresh entry, not (mis)adopt the consumed one.
    pushBackDismiss(() => {});
    expect(fake.pushCount()).toBe(2);
  });

  it("does not adopt while another overlay is still open", () => {
    pushBackDismiss(() => {}); // stays open
    pushBackDismiss(() => {}); // stacks a second entry, not an adoption
    expect(fake.pushCount()).toBe(2);
  });
});
