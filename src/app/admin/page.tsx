import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import AdminDashboard from "@/components/admin/AdminDashboard";

export const dynamic = "force-dynamic";

/**
 * Admin area (docs/ADMIN.md). Gated exactly like the API: a non-admin is
 * bounced as if the page didn't exist (redirect home — the API returns 404),
 * never a visible 403.
 */
export default async function AdminPage() {
  const user = await currentUser();
  if (!user) redirect("/signin");
  if (user.role !== "admin") redirect("/");
  return <AdminDashboard />;
}
