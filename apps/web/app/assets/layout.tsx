import { requireSession } from "@/lib/page-guards";

// Signed-in users only; pages inside narrow it further (a client sees only their brands).
export default async function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireSession();
  return children;
}
