import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CEREMONY_TIMEOUT_MS,
  EsignTimeoutError,
  classifyProbeError,
  probeFirestoreReachable,
  withTimeout,
} from "@/lib/esign/client";

// Guards the watchdog that turns a hung signing ceremony (bootstrap/enroll —
// charproof + Firestore steps that can HANG rather than reject, the installed-
// PWA "stuck on Setting up…" failure) into a visible, retryable error.

describe("withTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves with the value when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "x")).resolves.toBe(42);
  });

  it("propagates the original rejection (not a timeout) when it fails fast", async () => {
    const boom = new Error("boom");
    await expect(withTimeout(Promise.reject(boom), 1000, "x")).rejects.toBe(boom);
  });

  it("rejects with EsignTimeoutError when the promise never settles", async () => {
    vi.useFakeTimers();
    const hang = new Promise<number>(() => {}); // never settles
    const guarded = withTimeout(hang, CEREMONY_TIMEOUT_MS, "bootstrap");
    const assertion = expect(guarded).rejects.toBeInstanceOf(EsignTimeoutError);
    await vi.advanceTimersByTimeAsync(CEREMONY_TIMEOUT_MS + 1);
    await assertion;
  });

  it("carries a translatable code so the UI shows Errors.esign.timedOut", () => {
    const err = new EsignTimeoutError("bootstrap");
    expect(err.code).toBe("esign.timedOut");
    expect((err.payload as { code: string }).code).toBe("esign.timedOut");
  });
});

describe("classifyProbeError", () => {
  it("treats not-set-up signals as unreachable", () => {
    for (const code of ["permission-denied", "not-found", "unavailable", "failed-precondition"]) {
      expect(classifyProbeError({ code })).toBe("unreachable");
    }
  });

  it("fails open (ok) on unknown or codeless errors", () => {
    expect(classifyProbeError({ code: "aborted" })).toBe("ok");
    expect(classifyProbeError(new Error("boom"))).toBe("ok");
    expect(classifyProbeError(null)).toBe("ok");
  });
});

describe("probeFirestoreReachable", () => {
  it("is a no-op 'ok' off the production Firestore backend (never touches the SDK)", async () => {
    const base = { me: { userId: "u1" } } as never;
    await expect(probeFirestoreReachable({ ...(base as object), backend: "mock" } as never)).resolves.toBe(
      "ok"
    );
    await expect(
      probeFirestoreReachable({
        backend: "firestore",
        firebaseConfig: { emulator: { auth: "a", firestore: "f" } },
        me: { userId: "u1" },
      } as never)
    ).resolves.toBe("ok");
  });
});
