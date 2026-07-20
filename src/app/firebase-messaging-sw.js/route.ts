import { CLICK_ROUTE_PREFIXES } from "@/lib/notifications/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The push service worker, served as a ROUTE (docs/NOTIFICATIONS_DESIGN.md
 * §7.0): this deployment has no build-time config and the Docker image is
 * church-agnostic, so a static public/ file can't exist. Necessarily PUBLIC
 * (a named invariant-2 exception beside /c/[token]): browsers re-validate
 * the SW on push receipt and daily — often after the session cookie has
 * expired — and it serves only static handler code, no user data, no tenant
 * surface.
 *
 * The worker is deliberately SDK-free: we always send full webpush
 * notification payloads (§3), so the raw push event carries everything —
 * no firebase config, no CDN importScripts (WeChat-adjacent networks block
 * gstatic), no waiting-worker drift (skipWaiting + clients.claim, §7.0).
 */

const SW_VERSION = "1"; // bump to force a byte-diff redeploy of the worker

function swSource(): string {
  const prefixes = JSON.stringify(CLICK_ROUTE_PREFIXES);
  return `// Numbers push service worker v${SW_VERSION} (generated; see src/app/firebase-messaging-sw.js/route.ts)
self.addEventListener("install", function () {
  self.skipWaiting();
});
self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

// §7.5: only same-origin catalog routes — a forged payload must not deep-link
// a device anywhere else under the app's provenance.
var ROUTE_PREFIXES = ${prefixes};
function allowedRoute(route) {
  if (typeof route !== "string" || route.charAt(0) !== "/" || route.slice(0, 2) === "//") return "/";
  if (route === "/") return route;
  for (var i = 0; i < ROUTE_PREFIXES.length; i++) {
    var p = ROUTE_PREFIXES[i];
    if (p === "/") continue; // exact-match only, never a match-everything prefix
    if (p.charAt(p.length - 1) === "/") {
      if (route.slice(0, p.length) === p && route.length > p.length) return route;
    } else if (route === p || route.slice(0, p.length + 1) === p + "?" || route.slice(0, p.length + 1) === p + "#") {
      return route;
    }
  }
  return "/";
}

self.addEventListener("push", function (event) {
  if (!event.data) return;
  var payload;
  try {
    payload = event.data.json();
  } catch (e) {
    return;
  }
  var n = payload.notification || {};
  var route = allowedRoute(payload.data && payload.data.route);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
      var focused = null;
      for (var i = 0; i < clients.length; i++) {
        if (clients[i].focused) focused = clients[i];
      }
      if (focused) {
        // §8.9 foreground surface: the page shows an in-app toast (several
        // platforms show no system banner for a focused page).
        focused.postMessage({ type: "numbers-push", title: n.title || "", body: n.body || "", route: route });
        return;
      }
      return self.registration.showNotification(n.title || "Numbers", {
        body: n.body || "",
        tag: n.tag || undefined,
        renotify: false,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        data: { route: route },
      });
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var route = allowedRoute(event.notification.data && event.notification.data.route);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
      var client = null;
      for (var i = 0; i < clients.length; i++) {
        if ("focus" in clients[i]) client = clients[i];
      }
      if (client) {
        // Focus + postMessage navigation (§7.5): the page decides — it will
        // NOT navigate while a claim-generation stream is running.
        return client.focus().then(function (c) {
          (c || client).postMessage({ type: "numbers-navigate", route: route });
        });
      }
      return self.clients.openWindow(route);
    })
  );
});
`;
}

export async function GET() {
  return new Response(swSource(), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // §7.0: the browser byte-compares on registration/navigation/push/24h —
      // no-cache keeps that comparison honest, so SW fixes ship immediately.
      "cache-control": "no-cache",
    },
  });
}
