import {authenticated, session} from "@/lib/cognito-auth";
import {redirect} from "next/navigation";
import {AiGatewayLabClient} from "./client";

export default async function AiGatewayPage(){
 if(!(await authenticated())){
  // Signed in but not the owner (a client): nothing here for them, send them home.
  if(await session())redirect("/");
  redirect("/api/auth/login");
 }
 return <main className="main">
  <div className="eyebrow">Development tools · Brand content</div>
  <h1>AI Gateway Lab</h1>
  <p className="muted">Test the shared ChatGPT / Claude gateway against real brand assets. The dashboard remains your primary command center. Stock Gallery development is paused.</p>
  <AiGatewayLabClient />
 </main>;
}
