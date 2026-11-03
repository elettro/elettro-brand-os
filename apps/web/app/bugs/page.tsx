import { redirect } from "next/navigation";
import { session, superAdmin } from "@/lib/cognito-auth";
import registry from "../../../../docs/bug-fix/bugs.json";
import { BugsClient, type Bug } from "./bugs-client";

// Super admin only (the owner email): not the owner group, not clients. The data is docs/bug-fix/bugs.json, bundled at build.
export default async function BugsPage() {
  if (!(await session())) redirect("/api/auth/login");
  if (!(await superAdmin())) redirect("/");
  return <main className="main">
    <div className="eyebrow">Admin · Bug Tracker</div>
    <h1>Bug &amp; Fix Log</h1>
    <p className="muted">Every retained Elettro OS defect, searchable by symptom, area, status, severity, file or PR. The Markdown records in <code>docs/bug-fix/</code> are the source of truth; this page is the operational view of <code>bugs.json</code>.</p>
    <BugsClient bugs={registry.bugs as Bug[]} updated={registry.updated_at} />
  </main>;
}
