"use client";

/**
 * App-wide surface for pending device-authorization requests
 * (docs/MULTI_DEVICE_PLAN.md M3/D3 — app-wide because approval is
 * time-sensitive: the member is standing there holding both devices).
 * Renders nothing unless e-sign is on, this member is enrolled, THIS device
 * holds the keys, and a request is actually pending. On the real backend it
 * also never forces the Google sign-in popup: this banner mounts on EVERY
 * page, and a device that can approve necessarily signed into Firebase here
 * before — so it waits for that (persisted or fresh) session instead of
 * prompting on pages that have nothing to do with e-sign.
 */

import { useEffect, useRef, useState } from "react";
import { loadEnv, custodyFor, type EsignEnv } from "@/lib/esign/client";
import { watchPendingRequests, type PendingDeviceRequest } from "@/lib/esign/devices";
import { PendingRequestPrompt } from "./DeviceManager";

export default function DeviceRequestsBanner() {
  const [env, setEnv] = useState<EsignEnv | null>(null);
  const [requests, setRequests] = useState<PendingDeviceRequest[]>([]);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubAuth: (() => void) | null = null;
    const attach = async (loaded: EsignEnv) => {
      try {
        // Only a device that can actually unwrap the keys can approve.
        if ((await custodyFor(loaded).deviceStatus()) !== "ready") return;
        if (cancelled) return;
        setEnv(loaded);
        unsubRef.current = await watchPendingRequests(loaded, (reqs) => {
          if (!cancelled) setRequests(reqs);
        });
        if (cancelled) unsubRef.current?.();
      } catch {
        // Signed out / e-sign unreachable — the banner just stays hidden.
      }
    };
    void (async () => {
      try {
        const loaded = await loadEnv();
        if (cancelled) return;
        if (!loaded.bootstrapped || !loaded.enabled || loaded.allowed === false || !loaded.me.identityStatus)
          return;
        if (loaded.backend === "firestore") {
          // Attach only once a matching Firebase session exists (see header).
          let fired = false;
          const { onMatchingFirebaseAuth } = await import("@/lib/esign/firebase-client");
          unsubAuth = await onMatchingFirebaseAuth(() => {
            if (fired || cancelled) return;
            fired = true;
            unsubAuth?.();
            unsubAuth = null;
            void attach(loaded);
          });
          // The listener can fire before its unsubscribe is assigned.
          if (fired || cancelled) {
            unsubAuth();
            unsubAuth = null;
          }
          return;
        }
        await attach(loaded);
      } catch {
        // Signed out / e-sign unreachable — the banner just stays hidden.
      }
    })();
    return () => {
      cancelled = true;
      unsubAuth?.();
      unsubRef.current?.();
    };
  }, []);

  if (!env || requests.length === 0) return null;

  return (
    <div className="mx-auto max-w-6xl space-y-2 px-4 pt-4">
      {requests.map((request) => (
        <PendingRequestPrompt
          key={request.deviceId}
          env={env}
          request={request}
          onSettled={() => setRequests((prev) => prev.filter((r) => r.deviceId !== request.deviceId))}
        />
      ))}
    </div>
  );
}
