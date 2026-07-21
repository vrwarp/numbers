import { redirect } from "next/navigation";
import { currentUserId, signInPath } from "@/auth";
import CatalogDraftsReview from "@/components/mcp/CatalogDraftsReview";

export const dynamic = "force-dynamic";

/**
 * Proposed Changes — where catalog edits an AI assistant staged over the MCP
 * backend (docs/MCP_DESIGN.md) are reviewed and applied or discarded by an
 * authorized human. The API re-checks the manage role on every action; this
 * page is just the review surface.
 */
export default async function CatalogDraftsPage() {
  const userId = await currentUserId();
  if (!userId) redirect(signInPath("/catalog-drafts"));
  return (
    <div className="mx-auto max-w-2xl">
      <CatalogDraftsReview />
    </div>
  );
}
