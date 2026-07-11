// The mock device-sync adapter's concurrency semantics (docs/MULTI_DEVICE_PLAN.md
// M1/D4): CAS retry must mirror Firestore transactions closely enough that
// charproof's genesis race and concurrent approvals behave identically in mock
// and production. fetch is stubbed; no server or DB.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockDeviceSyncStore } from "@/lib/esign/device-sync";

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined;

function stubFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const res = handler(url, init);
    if (!res) throw new Error(`Unhandled fetch: ${init?.method ?? "GET"} ${url}`);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => res.body,
    } as Response;
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const DOC = { activeAmkId: "amk_v1", devices: {}, recoveryMethods: {}, keyring: { amk_v1: {} } };

describe("MockDeviceSyncStore CAS semantics", () => {
  it("retries transactAccountKeys on 409 and reruns the updater against fresh state", async () => {
    let version = 1;
    let conflictOnce = true;
    const casBodies: { baseVersion: number }[] = [];
    stubFetch((url, init) => {
      if (url.endsWith("/account-keys") && (!init || !init.method || init.method === "GET")) {
        return { status: 200, body: { doc: { ...DOC, seenVersion: version }, version } };
      }
      if (url.endsWith("/account-keys") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        casBodies.push(body);
        if (conflictOnce) {
          conflictOnce = false;
          version = 2; // someone else won the race
          return { status: 409, body: { error: "Version conflict — retry" } };
        }
        return { status: 200, body: { ok: true } };
      }
      return undefined;
    });

    const store = new MockDeviceSyncStore();
    const seen: number[] = [];
    await store.transactAccountKeys((current) => {
      seen.push((current as unknown as { seenVersion: number }).seenVersion);
      return current;
    });

    // Updater ran once against v1 (lost), once against v2 (won).
    expect(seen).toEqual([1, 2]);
    expect(casBodies.map((b) => b.baseVersion)).toEqual([1, 2]);
  });

  it("gives up with a clear error when the document never stops conflicting", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/account-keys") && (!init || !init.method || init.method === "GET")) {
        return { status: 200, body: { doc: DOC, version: 1 } };
      }
      if (init?.method === "POST") return { status: 409, body: { error: "conflict" } };
      return undefined;
    });
    const store = new MockDeviceSyncStore();
    await expect(store.transactAccountKeys((d) => d)).rejects.toThrow(/conflicting/);
  }, 15_000);

  it("maps createAccountKeys onto atomic create-if-absent (genesis race)", async () => {
    let exists = false;
    stubFetch((url, init) => {
      if (url.endsWith("/account-keys") && init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        expect(body.create).toBe(true);
        const created = !exists;
        exists = true;
        return { status: 200, body: { created } };
      }
      return undefined;
    });
    const store = new MockDeviceSyncStore();
    await expect(store.createAccountKeys(DOC as never)).resolves.toBe(true);
    await expect(store.createAccountKeys(DOC as never)).resolves.toBe(false);
  });

  it("transactApproveDevice flips the pending doc in the same CAS write", async () => {
    let pendingPatch: unknown = null;
    stubFetch((url, init) => {
      if (url.endsWith("/account-keys") && (!init || !init.method || init.method === "GET")) {
        return { status: 200, body: { doc: DOC, version: 5 } };
      }
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        pendingPatch = body.pending;
        expect(body.baseVersion).toBe(5);
        return { status: 200, body: { ok: true } };
      }
      return undefined;
    });
    const store = new MockDeviceSyncStore();
    await store.transactApproveDevice((d) => d, "device-b", { status: "authorized" } as never);
    expect(pendingPatch).toEqual({ deviceId: "device-b", patch: { status: "authorized" } });
  });

  it("transactAccountKeys refuses when no account document exists", async () => {
    stubFetch((url, init) => {
      if (!init || !init.method || init.method === "GET") {
        return { status: 200, body: { doc: null, version: 0 } };
      }
      return undefined;
    });
    const store = new MockDeviceSyncStore();
    await expect(store.transactAccountKeys((d) => d)).rejects.toThrow(/Account keys missing/);
  });
});
