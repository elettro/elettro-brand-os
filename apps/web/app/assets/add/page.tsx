import { IntakeClient } from "./intake-client";
import { authenticated } from "@/lib/cognito-auth";
import { redirect } from "next/navigation";

export default async function AddAssetsPage() {
  if (!(await authenticated())) redirect("/api/auth/login");
  return (
    <main className="main">
      <div className="eyebrow">Asset Intake</div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:16,flexWrap:"wrap"}}>
        <h1>Add Assets</h1>
        <a href="/api/auth/logout" style={{padding:"9px 14px",border:"1px solid #94a3b8",borderRadius:8,fontWeight:700,textDecoration:"none"}}>Log out</a>
      </div>
      <p className="muted">
        Drag in a batch, give the group only the context you know now, and let Brand OS analyze the rest.
      </p>
      <div style={{ marginTop: 20 }}>
        <IntakeClient />
      </div>
    </main>
  );
}
