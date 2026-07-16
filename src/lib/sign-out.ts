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
  await fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
  window.location.assign("/signin");
}
