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

/**
 * Running as an INSTALLED standalone app (Android WebAPK, iOS home-screen),
 * not a normal browser tab? This is the case Firebase's signInWithPopup can't
 * survive: on Android Chrome the popup opens a Custom Tab whose postMessage
 * handshake never reaches the app window (the flow HANGS, never erroring — so
 * an error-catch fallback can't save it), and on iOS the popup is blocked
 * outright. Both the login (SignInCard) and e-sign connect paths detect this
 * up front and go straight to signInWithRedirect. `display-mode: browser`
 * (a normal tab) returns false, so tabs keep the nicer popup. Client-safe.
 */
export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  const mm = window.matchMedia;
  const displayStandalone =
    typeof mm === "function" &&
    ["standalone", "fullscreen", "minimal-ui"].some((mode) => {
      try {
        return mm(`(display-mode: ${mode})`).matches;
      } catch {
        return false;
      }
    });
  // iOS home-screen web apps report this instead of a display-mode match.
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return displayStandalone || iosStandalone;
}
