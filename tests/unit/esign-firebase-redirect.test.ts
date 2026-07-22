import { describe, expect, it } from "vitest";
import { shouldRedirectAuth } from "@/lib/esign/firebase-client";

// Guards the popup-blocked -> signInWithRedirect fallback that unblocks
// e-sign setup inside an installed home-screen PWA (docs/ESIGN_DESIGN.md §9.2;
// the SignInCard login precedent). Redirect is trusted ONLY when the auth
// proxy has made the redirect handler first-party (authDomain === our origin).
const HOST = "numbers.example.org";

describe("shouldRedirectAuth", () => {
  it("redirects a blocked popup when the authDomain is first-party (auth proxy on)", () => {
    expect(shouldRedirectAuth({ authDomain: HOST }, "auth/popup-blocked", HOST)).toBe(true);
  });

  it("redirects an unsupported-environment popup too (some standalone PWAs)", () => {
    expect(
      shouldRedirectAuth({ authDomain: HOST }, "auth/operation-not-supported-in-environment", HOST)
    ).toBe(true);
  });

  it("does NOT redirect when the authDomain is third-party (*.firebaseapp.com)", () => {
    // Redirect round-trip breaks under WebKit storage partitioning off-origin.
    expect(shouldRedirectAuth({ authDomain: "proj.firebaseapp.com" }, "auth/popup-blocked", HOST)).toBe(
      false
    );
  });

  it("does NOT redirect for a user-cancelled or generic popup failure", () => {
    expect(shouldRedirectAuth({ authDomain: HOST }, "auth/popup-closed-by-user", HOST)).toBe(false);
    expect(shouldRedirectAuth({ authDomain: HOST }, "auth/cancelled-popup-request", HOST)).toBe(false);
    expect(shouldRedirectAuth({ authDomain: HOST }, "", HOST)).toBe(false);
  });

  it("never redirects on the emulator (no popup to fall back from)", () => {
    expect(
      shouldRedirectAuth({ authDomain: HOST, emulator: { auth: "x", firestore: "y" } }, "auth/popup-blocked", HOST)
    ).toBe(false);
  });

  it("never redirects with no config", () => {
    expect(shouldRedirectAuth(null, "auth/popup-blocked", HOST)).toBe(false);
  });
});
