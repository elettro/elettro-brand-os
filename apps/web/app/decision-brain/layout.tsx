import { redirect } from "next/navigation";
import { authenticated } from "@/lib/cognito-auth";

// The preview reads the asset library, so it needs a signed-in visitor like the other library pages.
export default async function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  if (!(await authenticated())) redirect("/api/auth/login");
  return children;
}
