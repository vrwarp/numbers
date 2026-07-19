"use client";

/**
 * Getting a PDF out of the app on every platform.
 *
 * The classic web pattern — blob URL + programmatic `<a download>` click —
 * silently no-ops in iOS home-screen (standalone) web apps, and a
 * `window.open` there lands in an overlay browser that does NOT share the
 * PWA's session cookie (authenticated GETs show the sign-in page). The
 * iOS-idiomatic delivery is the OS share sheet (Save to Files / Print /
 * AirDrop / Mail), which `navigator.share({files})` opens.
 *
 * Strategy: in standalone mode share; everywhere else keep the plain
 * download (desktop browsers give it a real filename + download UI).
 * `navigator.share` needs transient user activation — if the triggering tap
 * was spent on a slow fetch, callers get `false` back and must render a
 * fresh-gesture "Save / Share" button wired to `sharePdf`.
 */

export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.("(display-mode: standalone)")?.matches === true;
}

export function pdfFile(bytes: BlobPart, filename: string): File {
  return new File([bytes], filename, { type: "application/pdf" });
}

/**
 * Open the OS share sheet for a PDF. "shared" covers user-cancel too (the
 * sheet appeared — delivery UI did its job); "blocked" = transient activation
 * was already spent, retry from a fresh tap; "unavailable" = no file-share
 * support here.
 */
export async function sharePdf(file: File): Promise<"shared" | "blocked" | "unavailable"> {
  if (typeof navigator === "undefined" || !navigator.canShare?.({ files: [file] })) {
    return "unavailable";
  }
  try {
    await navigator.share({ files: [file] });
    return "shared";
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "AbortError") return "shared";
    if (name === "NotAllowedError") return "blocked";
    return "unavailable";
  }
}

/** Share any blob (receipt images included) under its own MIME type. */
export async function shareBlob(blob: Blob, filename: string) {
  return sharePdf(new File([blob], filename, { type: blob.type || "application/octet-stream" }));
}

/**
 * Standalone-mode replacement for `<a href target="_blank">` on
 * AUTHENTICATED file URLs: the standalone overlay browser has no session
 * cookie (the link would land on the sign-in page), so fetch the bytes
 * in-app — where the cookie exists — and hand them to the share sheet.
 */
export async function fetchAndDeliver(href: string, filename: string): Promise<void> {
  const res = await fetch(href);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const blob = await res.blob();
  const outcome = await shareBlob(blob, filename);
  if (outcome !== "shared") downloadBlob(blob, filename);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Deliver a PDF the platform-appropriate way. Returns `false` only when the
 * share sheet was the right channel but needs a fresh user gesture — the
 * caller should surface a "Save / Share" button that calls `sharePdf`.
 */
export async function deliverPdf(blob: Blob, filename: string): Promise<boolean> {
  if (isStandalonePwa()) {
    const outcome = await sharePdf(pdfFile(blob, filename));
    if (outcome === "shared") return true;
    if (outcome === "blocked") return false;
    // share unavailable → best-effort fall through to the download attempt
  }
  downloadBlob(blob, filename);
  return true;
}
