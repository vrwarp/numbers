/**
 * Client capture layer (docs/FEEDBACK_DESIGN.md §3). Passive, redacted, and
 * strictly fire-and-forget — nothing here can gate or fail an app action (the
 * invariant-11/12 posture). It keeps a small breadcrumb ring in sessionStorage
 * (survives a crash-then-reload), stamps a correlation id on every same-origin
 * API fetch, and remembers the last uncaught error so the boundary and the
 * report sheet can attach it. Everything DOM-touching is guarded so this module
 * is import-safe on the server. Values NEVER enter the ring — only shapes
 * (see redact.ts). Install once from the app-wide FeedbackRuntime.
 */
import type { Breadcrumb, CrashInfo, Diagnostics } from "./types";
import { templatePath, scrubText } from "./redact";
import { isSensitiveRoute } from "./sensitive";

const RING_KEY = "numbers.fb.crumbs";
const CRASH_KEY = "numbers.fb.crash";
const MAX_CRUMBS = 25;

let installed = false;
let lastCrash: CrashInfo | null = null;

function newRid(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  } catch {
    return `r${Date.now().toString(36)}`;
  }
}

function loadRing(): Breadcrumb[] {
  if (typeof sessionStorage === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(RING_KEY);
    return raw ? (JSON.parse(raw) as Breadcrumb[]) : [];
  } catch {
    return [];
  }
}

function saveRing(ring: Breadcrumb[]): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(RING_KEY, JSON.stringify(ring));
  } catch {
    // storage full / disabled — capture is best-effort, never load-bearing.
  }
}

export function pushCrumb(c: Breadcrumb): void {
  const ring = loadRing();
  ring.push(c);
  while (ring.length > MAX_CRUMBS) ring.shift();
  saveRing(ring);
}

export function getCrumbs(): Breadcrumb[] {
  return loadRing();
}

/** Record a navigation (the runtime calls this on pathname change). */
export function recordNav(pathname: string): void {
  pushCrumb({ t: Date.now(), kind: "nav", label: templatePath(pathname || "/") });
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

function isApi(url: string): boolean {
  try {
    return new URL(url, location.href).pathname.startsWith("/api");
  } catch {
    return false;
  }
}

// Wrap fetch to (a) stamp x-request-id on same-origin string requests and
// (b) breadcrumb /api calls. Bodies are NEVER read (that would break the app's
// streaming NDJSON reads and could consume a response), so no error `code` is
// captured here — status + correlation id are the shape we keep.
function installFetch(): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const isStr = typeof input === "string" || input instanceof URL;
    const url = isStr ? String(input) : (input as Request).url;
    const method = (
      init?.method || (!isStr ? (input as Request).method : "GET") || "GET"
    ).toUpperCase();
    const same = sameOrigin(url);
    const api = same && isApi(url);
    let rid: string | undefined;
    let nextInit = init;
    // Only mutate headers for string/URL same-origin calls; a Request object is
    // passed through untouched to avoid corrupting a caller's constructed body.
    if (isStr && same) {
      rid = newRid();
      const h = new Headers((init?.headers as HeadersInit | undefined) ?? undefined);
      if (!h.has("x-request-id")) h.set("x-request-id", rid);
      nextInit = { ...init, headers: h };
    }
    const start = Date.now();
    try {
      const res = await orig(input as RequestInfo | URL, nextInit);
      if (api) {
        const serverRid = res.headers.get("x-request-id") || rid;
        pushCrumb({
          t: Date.now(),
          kind: "api",
          label: `${method} ${templatePath(url)}`,
          status: res.status,
          rid: serverRid || undefined,
          ms: Date.now() - start,
        });
      }
      return res;
    } catch (err) {
      if (api) {
        pushCrumb({
          t: Date.now(),
          kind: "api",
          label: `${method} ${templatePath(url)}`,
          status: 0,
          rid,
          ms: Date.now() - start,
        });
      }
      throw err;
    }
  };
}

function noteError(message: string, stack: string): void {
  const msg = scrubText(message || "Error", 300);
  lastCrash = { message: msg, stack: scrubText(stack || "", 1200) };
  pushCrumb({ t: Date.now(), kind: "error", label: msg });
}

function installErrorHooks(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (e: ErrorEvent) => {
    noteError(e.message, (e.error && (e.error as Error).stack) || "");
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const reason = e.reason as { message?: string; stack?: string } | string | undefined;
    const message =
      typeof reason === "string" ? reason : reason?.message || "Unhandled rejection";
    noteError(message, (typeof reason === "object" && reason?.stack) || "");
  });
}

/** Idempotent install of fetch + error instrumentation. */
export function installCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  installFetch();
  installErrorHooks();
}

/** The error boundary stashes a crash so a post-reload report can attach it. */
export function stashCrash(crash: CrashInfo): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(
      CRASH_KEY,
      JSON.stringify({ message: scrubText(crash.message, 300), stack: scrubText(crash.stack, 1200) })
    );
  } catch {
    /* best-effort */
  }
}

export function takeStashedCrash(): CrashInfo | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(CRASH_KEY);
    if (raw) sessionStorage.removeItem(CRASH_KEY);
    return raw ? (JSON.parse(raw) as CrashInfo) : null;
  } catch {
    return null;
  }
}

export function lastCapturedCrash(): CrashInfo | null {
  return lastCrash;
}

/** Assemble the redacted diagnostics bundle for a report. */
export function buildDiagnostics(pathname: string, crash?: CrashInfo | null): Diagnostics {
  const crumbs = getCrumbs();
  const requestIds = [...new Set(crumbs.filter((c) => c.rid).map((c) => c.rid as string))].slice(-8);
  const nav =
    typeof navigator !== "undefined"
      ? navigator
      : ({ userAgent: "", language: "", platform: "" } as Navigator);
  const w = typeof window !== "undefined" ? window : undefined;
  return {
    route: templatePath(pathname || (w ? location.pathname : "/")),
    sensitive: isSensitiveRoute(pathname),
    env: {
      ua: nav.userAgent || "",
      lang: nav.language || "",
      platform: (nav as Navigator & { platform?: string }).platform || "",
      viewport: w ? `${w.innerWidth}x${w.innerHeight}` : "",
      dpr: w ? w.devicePixelRatio || 1 : 1,
    },
    breadcrumbs: crumbs,
    requestIds,
    crash: crash ?? lastCrash,
    capturedAt: Date.now(),
  };
}
