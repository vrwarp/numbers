/**
 * In-app browser detection (WeChat, Line, Facebook/Messenger/Instagram
 * webviews, Google app…): no OAuth popups, no share-sheet install controls —
 * sign-in AND the push capability pre-flight both refuse to sell what these
 * contexts can't deliver (docs/NOTIFICATIONS_DESIGN.md §8.3 step 0).
 * Client-safe, dependency-free.
 */
export function isEmbeddedBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /\bFBAN|\bFBAV|FB_IAB|Messenger|Instagram|Line\/|MicroMessenger|; ?wv\)|\bGSA\//.test(ua);
}
