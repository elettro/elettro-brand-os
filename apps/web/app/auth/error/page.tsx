import Link from "next/link";
export default async function AuthenticationError({searchParams}:{searchParams:Promise<{reason?:string}>}) {
  const {reason}=await searchParams;
  const allowed=["Account not authorized","Cognito rejected authentication","Cognito user pool is not configured","Missing authorization code","Invalid OAuth state","Cognito client secret is not configured"];
  const message=allowed.includes(reason||"")?reason:"Sign-in did not complete. Please contact your administrator if this continues.";
  return <main style={{maxWidth:650,margin:"12vh auto",padding:28,fontFamily:"system-ui"}}>
    <h1>Elettro sign-in needs attention</h1>
    <p>{message}</p>
    <p>The application did not accept the login; the redirect loop has been stopped.</p>
    <Link href="/api/auth/login">Try signing in again</Link>
  </main>;
}
