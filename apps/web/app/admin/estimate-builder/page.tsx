import { redirect } from "next/navigation";
import { authenticated, session } from "@/lib/cognito-auth";

export const metadata = { title: "Estimate Builder | Elettro OS", robots: { index: false, follow: false } };

// Private owner-only playground for services, pricing, packages and estimates.
// Standalone: the estimator is a self-contained page shown in a frame, with no data, APIs or accounts behind it.
export default async function EstimateBuilderPage() {
  if (!(await authenticated())) {
    // Signed in but not the owner (a client): nothing here for them, send them home.
    if (await session()) redirect("/");
    redirect("/api/auth/login");
  }
  return <iframe src="/admin/estimate-builder/frame" title="Elettro Estimate Builder" style={{ display: "block", width: "100%", height: "calc(100vh - 60px)", border: 0 }} />;
}
