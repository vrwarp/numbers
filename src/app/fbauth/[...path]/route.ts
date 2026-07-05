import type { NextRequest } from "next/server";
import { firebaseAuthUpstreamHost } from "@/lib/config";

/**
 * Reverse proxy for Firebase Auth's sign-in helper. next.config.ts rewrites the
 * `/__/auth/*` and `/__/firebase/*` paths (the endpoints the Firebase JS SDK
 * expects on its authDomain) onto this route, and we forward them to the
 * project's real `*.firebaseapp.com` handler (FIREBASE_AUTH_DOMAIN). Serving
 * the handler from our own origin keeps the sign-in iframe/redirect first-party
 * so WebKit storage partitioning doesn't break Google sign-in on iOS — enabled
 * by FIREBASE_AUTH_PROXY (see src/lib/config.ts).
 *
 * Deliberately public: this IS the sign-in endpoint, so — like GET /c/[token] —
 * it must not go through requireUserId.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Headers that describe the transfer rather than the payload: once fetch has
// decoded the body they no longer match it, so they must not be forwarded.
const HOP_BY_HOP = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

async function proxy(req: NextRequest, path: string[]): Promise<Response> {
  const upstreamHost = firebaseAuthUpstreamHost();
  if (!upstreamHost || path.length === 0) {
    return new Response("Not found", { status: 404 });
  }
  // Guard against a config that resolves the upstream to our own origin, which
  // would make the proxy call itself (TLS ECONNRESET / request loop).
  if (upstreamHost === req.headers.get("host")) {
    return new Response("Auth proxy upstream resolves to this origin", { status: 500 });
  }

  const upstream = new URL(`https://${upstreamHost}/__/${path.join("/")}`);
  upstream.search = req.nextUrl.search;

  const reqHeaders = new Headers(req.headers);
  reqHeaders.delete("host"); // fetch derives Host from the upstream URL

  const res = await fetch(upstream, {
    method: req.method,
    headers: reqHeaders,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    redirect: "manual",
  });

  const headers = new Headers();
  res.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key) && key !== "set-cookie") headers.set(key, value);
  });
  // Cookies scoped to *.firebaseapp.com would be dropped on our origin — rebind
  // them to our host by stripping the Domain attribute.
  for (const cookie of res.headers.getSetCookie()) {
    headers.append("set-cookie", cookie.replace(/;\s*Domain=[^;]*/i, ""));
  }
  // A redirect that points back at the upstream host would leave our origin and
  // re-introduce the third-party context; keep it local.
  const location = headers.get("location");
  const ownHost = req.headers.get("host");
  if (location && ownHost) {
    headers.set("location", location.replace(`//${upstreamHost}`, `//${ownHost}`));
  }

  return new Response(res.body, { status: res.status, headers });
}

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export { handle as GET, handle as POST, handle as HEAD, handle as OPTIONS };
