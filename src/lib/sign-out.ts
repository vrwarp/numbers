"use client";

/**
 * Remove every `numbers.search.*` entry from web storage. Recent queries and
 * cached results are namespaced by userId but persist across sign-out (§7.2
 * says both storages are cleared on sign-out) — on a shared device the next
 * user could otherwise read the previous one's search history in plaintext.
 */
export function clearSearchStorage(): void {
  for (const store of [
    typeof localStorage !== "undefined" ? localStorage : null,
    typeof sessionStorage !== "undefined" ? sessionStorage : null,
  ]) {
    if (!store) continue;
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith("numbers.search.")) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  }
}

/** Clear the server session and land on the sign-in page (NavBar + Profile). */
export async function signOut(): Promise<void> {
  try {
    clearSearchStorage();
  } catch {
    // Storage disabled (private mode / SSR) — nothing to clear.
  }
  // §8.6 shared machines: sever THIS installation's push token before the
  // session goes — a treasurer's finance pushes must not pop on the office
  // screen after she leaves. Server row delete is what stops delivery; the
  // FCM-side subscription reaps on its next send error.
  try {
    const token =
      localStorage.getItem("numbers.push.token") ?? localStorage.getItem("numbers_mock_push_token");
    if (token) {
      await fetch("/api/notifications/token", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }).catch(() => {});
      localStorage.removeItem("numbers.push.token");
    }
  } catch {
    // Storage disabled — nothing registered from this context either.
  }
  await fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
  window.location.assign("/signin");
}
