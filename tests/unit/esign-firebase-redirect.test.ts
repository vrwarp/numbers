import { afterEach, describe, expect, it, vi } from "vitest";
import { isFirstPartyRedirect, shouldRedirectAuth } from "@/lib/esign/firebase-client";
import { isStandaloneDisplay } from "@/lib/embedded-browser";

// Guards the standalone-PWA -> signInWithRedirect path that unblocks e-sign
// setup and login inside an installed app (docs/ESIGN_DESIGN.md §9.2). In a
// standalone PWA the popup HANGS on Android / is blocked on iOS, so we detect
// the display up front; redirect is trusted ONLY when the auth proxy has made
// the redirect handler first-party (authDomain === our origin).
const HOST = "numbers.example.org";

describe("isFirstPartyRedirect", () => {
  it("is true only when the authDomain equals our own origin (auth proxy on)", () => {
    expect(isFirstPartyRedirect({ authDomain: HOST }, HOST)).toBe(true);
  });

  it("is false for a third-party *.firebaseapp.com authDomain (no proxy)", () => {
    expect(isFirstPartyRedirect({ authDomain: "proj.firebaseapp.com" }, HOST)).toBe(false);
  });

  it("is false on the emulator and with no config", () => {
    expect(isFirstPartyRedirect({ authDomain: HOST, emulator: { auth: "x", firestore: "y" } }, HOST)).toBe(
      false
    );
    expect(isFirstPartyRedirect(null, HOST)).toBe(false);
  });
});

describe("shouldRedirectAuth (popup-blocked fallback in a normal tab)", () => {
  it("redirects a blocked/unsupported popup when first-party", () => {
    expect(shouldRedirectAuth({ authDomain: HOST }, "auth/popup-blocked", HOST)).toBe(true);
    expect(
      shouldRedirectAuth({ authDomain: HOST }, "auth/operation-not-supported-in-environment", HOST)
    ).toBe(true);
  });

  it("does NOT redirect a third-party popup block (off-origin round-trip breaks)", () => {
    expect(shouldRedirectAuth({ authDomain: "proj.firebaseapp.com" }, "auth/popup-blocked", HOST)).toBe(
      false
    );
  });

  it("does NOT redirect a user-cancelled or generic popup failure", () => {
    expect(shouldRedirectAuth({ authDomain: HOST }, "auth/popup-closed-by-user", HOST)).toBe(false);
    expect(shouldRedirectAuth({ authDomain: HOST }, "auth/cancelled-popup-request", HOST)).toBe(false);
    expect(shouldRedirectAuth({ authDomain: HOST }, "", HOST)).toBe(false);
  });
});

describe("isStandaloneDisplay", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubWindow(win: unknown) {
    vi.stubGlobal("window", win);
  }

  it("detects an installed app via display-mode: standalone (Android WebAPK)", () => {
    stubWindow({
      matchMedia: (q: string) => ({ matches: q.includes("standalone") }),
      navigator: {},
    });
    expect(isStandaloneDisplay()).toBe(true);
  });

  it("detects an iOS home-screen app via navigator.standalone", () => {
    stubWindow({
      matchMedia: () => ({ matches: false }),
      navigator: { standalone: true },
    });
    expect(isStandaloneDisplay()).toBe(true);
  });

  it("is false in a normal browser tab (display-mode: browser)", () => {
    stubWindow({
      matchMedia: () => ({ matches: false }),
      navigator: { standalone: false },
    });
    expect(isStandaloneDisplay()).toBe(false);
  });

  it("is false (never throws) when matchMedia is unavailable", () => {
    stubWindow({ navigator: {} });
    expect(isStandaloneDisplay()).toBe(false);
  });
});
