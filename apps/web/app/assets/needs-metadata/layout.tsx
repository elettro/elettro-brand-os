import { requireOwner } from "@/lib/page-guards";

// Owner only for now; clients are sent home.
export default async function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireOwner();
  return children;
}
