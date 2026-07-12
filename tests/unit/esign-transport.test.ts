import { describe, expect, it } from "vitest";
import { initializeApp } from "firebase/app";
import { initializeFirestore } from "firebase/firestore";
import { EMULATOR_FIRESTORE_SETTINGS, FIRESTORE_SETTINGS } from "@/lib/esign/firebase-client";

/**
 * Canary for the e-sign Firestore transport (firebase-client.ts): both
 * settings objects pin `useFetchStreams: false` — a private-but-honored
 * setting WebKit depends on (its fetch transport dies with "… due to access
 * control checks") — and the SDK rejects some knob combinations outright
 * (e.g. force + autoDetect long polling). Feeding the REAL initializeFirestore
 * here makes a firebase upgrade that rejects either object fail in `npm test`
 * instead of at the first production ceremony. (An upgrade that silently
 * IGNORES useFetchStreams is not detectable from public API — re-verify on
 * Safari when bumping firebase.)
 */
describe("e-sign Firestore transport settings", () => {
  it("production: XHR transport + autodetect long polling, accepted by the real SDK", () => {
    expect((FIRESTORE_SETTINGS as { useFetchStreams?: boolean }).useFetchStreams).toBe(false);
    const app = initializeApp({ apiKey: "x", projectId: "demo-transport" }, "transport-prod");
    expect(() => initializeFirestore(app, FIRESTORE_SETTINGS)).not.toThrow();
  });

  it("emulator: XHR transport + forced long polling, accepted by the real SDK", () => {
    expect((EMULATOR_FIRESTORE_SETTINGS as { useFetchStreams?: boolean }).useFetchStreams).toBe(
      false
    );
    const app = initializeApp({ apiKey: "x", projectId: "demo-transport" }, "transport-emu");
    expect(() => initializeFirestore(app, EMULATOR_FIRESTORE_SETTINGS)).not.toThrow();
  });
});
