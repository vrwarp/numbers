"use client";

/**
 * In-page camera QR scanner for the vouching ceremony (docs/ESIGN_DESIGN.md
 * §4.3). The scan is the binding channel, so this lives inside the voucher's
 * OWN browser — the one already holding their session cookie and signing key
 * — instead of relying on the phone's camera app opening `/vouch?c=…` in
 * whatever browser happens to be the default (a fresh, unauthenticated,
 * un-enrolled context on multi-browser devices).
 *
 * The decoder (nimiq `qr-scanner`) is loaded on demand from the button click,
 * so nobody pays its bytes unless they scan. It uses the native
 * `BarcodeDetector` where present (Android Chrome) and a bundled worker
 * everywhere else — iOS Safari has no `BarcodeDetector`, and church devices
 * skew iOS. Camera failures fall back to the manual paths below the scanner.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { VouchSubject } from "@/lib/esign/client";
import { subjectFromScan } from "@/lib/esign/vouch-scan";

type ScanState = "idle" | "starting" | "scanning" | "error";

// Structural type so we don't import qr-scanner's types at module load.
type Scanner = { start: () => Promise<void>; stop: () => void; destroy: () => void };

export default function VouchQrScanner({
  onScan,
}: {
  onScan: (subject: VouchSubject) => void;
}) {
  const t = useTranslations("VouchScan");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<Scanner | null>(null);
  const [state, setState] = useState<ScanState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notVouch, setNotVouch] = useState(false);

  // Always release the camera when this component leaves the screen (unmount
  // happens the instant a scan resolves and the parent swaps in the subject).
  useEffect(() => {
    return () => {
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
  }, []);

  async function start() {
    setError(null);
    setNotVouch(false);
    setState("starting");
    // getUserMedia needs a secure context; without it (plain-HTTP LAN IP,
    // ancient browser) there is nothing to load. localhost counts as secure.
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setState("error");
      setError(t("insecure"));
      return;
    }
    try {
      const { default: QrScanner } = await import("qr-scanner");
      const video = videoRef.current;
      if (!video) return;
      const scanner: Scanner = new QrScanner(
        video,
        (result: { data: string }) => {
          const subject = subjectFromScan(result.data);
          if (!subject) {
            // A QR that isn't a vouch code — keep the camera running.
            setNotVouch(true);
            return;
          }
          scanner.stop();
          onScan(subject);
        },
        {
          returnDetailedScanResult: true,
          preferredCamera: "environment",
          highlightScanRegion: true,
          highlightCodeOutline: true,
          maxScansPerSecond: 5,
        },
      );
      scannerRef.current = scanner;
      await scanner.start();
      setState("scanning");
    } catch (err) {
      scannerRef.current?.destroy();
      scannerRef.current = null;
      setState("error");
      const name = (err as { name?: string } | null)?.name;
      setError(
        name === "NotAllowedError" || name === "SecurityError" ? t("denied") : t("startFailed"),
      );
    }
  }

  function stop() {
    scannerRef.current?.destroy();
    scannerRef.current = null;
    setState("idle");
    setError(null);
    setNotVouch(false);
  }

  const live = state === "starting" || state === "scanning";

  return (
    <div className="space-y-2" data-testid="vouch-scanner">
      {/* The video must exist in the DOM before scanner.start() measures it,
          so render it whenever the camera is (or is about to be) live. */}
      <div className={live ? "relative overflow-hidden rounded-xl bg-black" : "hidden"}>
        <video
          ref={videoRef}
          className="w-full"
          playsInline
          muted
          data-testid="scan-video"
        />
        {state === "scanning" && (
          <p className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/50 p-2 text-center text-xs text-white">
            {t("aim")}
          </p>
        )}
      </div>

      {live ? (
        <button
          type="button"
          className="btn-secondary w-full"
          onClick={stop}
          data-testid="scan-cancel"
        >
          {t("cancel")}
        </button>
      ) : (
        <button
          type="button"
          className="btn-primary w-full"
          onClick={start}
          data-testid="scan-open"
        >
          {t("open")}
        </button>
      )}

      {notVouch && state === "scanning" && (
        <p className="text-xs text-amber-700" data-testid="scan-not-vouch">
          {t("notVouch")}
        </p>
      )}
      {state === "error" && error && (
        <p className="rounded-lg bg-red-50 p-2 text-xs text-red-700" data-testid="scan-error">
          {error}
        </p>
      )}
    </div>
  );
}
