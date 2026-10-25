import { redirect } from "next/navigation";
import { authenticated } from "@/lib/cognito-auth";

// Signed-out visitors go to the sign-in page, same as /review and /connections.
export default async function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  if (!(await authenticated())) redirect("/api/auth/login");
  return children;
}
