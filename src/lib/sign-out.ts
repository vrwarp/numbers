"use client";

/** Clear the server session and land on the sign-in page (NavBar + Profile). */
export async function signOut(): Promise<void> {
  await fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
  window.location.assign("/signin");
}
