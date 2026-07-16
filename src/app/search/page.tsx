import { redirect, notFound } from "next/navigation";
import { currentUserId } from "@/auth";
import { prisma } from "@/lib/prisma";
import { embeddingEnabled } from "@/lib/embeddings/settings";
import SearchClient from "@/components/SearchClient";

export const dynamic = "force-dynamic";

/** Semantic search (docs/SEARCH_DESIGN.md §7). The server component resolves
 *  the caller's role capabilities so the client renders only the controls this
 *  user may touch; the whole surface 404s while the feature is unconfigured. */
export default async function SearchPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");
  if (!(await embeddingEnabled())) notFound();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  const isRoleHolder = ["approver", "treasurer", "admin"].includes(user?.role ?? "");
  return <SearchClient userId={userId} isRoleHolder={isRoleHolder} />;
}
