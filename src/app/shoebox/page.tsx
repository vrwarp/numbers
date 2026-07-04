import { redirect } from "next/navigation";

// The Shoebox is the home page now; keep old links and bookmarks working.
export default function ShoeboxPage() {
  redirect("/");
}
