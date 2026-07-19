import { redirect, notFound } from "next/navigation";
import { currentUserId } from "@/auth";
import { searchCapabilitiesFor } from "@/lib/roles";
import { embeddingEnabled } from "@/lib/embeddings/settings";
import SearchClient from "@/components/SearchClient";

export const dynamic = "force-dynamic";

/** Semantic search (docs/SEARCH_DESIGN.md §7). The server component resolves
 *  the caller's search capabilities — the verified role mirror narrowed by the
 *  A10 duty pauses (§6.3) — so the client renders only the scopes this user may
 *  touch; the whole surface 404s while the feature is unconfigured. */
export default async function SearchPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");
  if (!(await embeddingEnabled())) notFound();
  const caps = await searchCapabilitiesFor(userId);
  return (
    <SearchClient
      userId={userId}
      canAll={caps.canAll}
      canDecided={caps.canDecided}
      canTeam={caps.canTeam}
    />
  );
}
