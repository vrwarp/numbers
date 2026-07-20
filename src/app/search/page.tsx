import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { currentUserId, signInPath } from "@/auth";
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
  if (!userId) redirect(signInPath("/search"));
  if (!(await embeddingEnabled())) {
    // Bookmarked /search links land here between config changes — a bare 404
    // reads as "broken", not "not set up". (The API keeps its plain 404.)
    const t = await getTranslations("Search");
    return (
      <div className="card mx-auto max-w-md p-8 text-center text-stone-500">
        <div className="text-3xl">🔍</div>
        <p className="mt-2 font-medium text-stone-700">{t("unavailableTitle")}</p>
        <p className="mt-1 text-sm">{t("unavailableBody")}</p>
      </div>
    );
  }
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
