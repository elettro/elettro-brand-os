import { requireOwner } from "@/lib/page-guards";

// Elettro MultiCam host page: owner only (the host opens sessions and holds the QR code).
export default async function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireOwner();
  return children;
}
