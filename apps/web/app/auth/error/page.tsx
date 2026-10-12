import Link from "next/link";
const descriptions:Record<string,string>={
  state:"Cognito sign-in state could not be verified.",
  token_exchange:"Cognito rejected the authorization code exchange.",
  owner_not_authorized:"The signed-in account is not authorized as the DEV owner, or its email is not verified.",
  pool_config:"The Cognito user pool setting is unavailable to the server.",
  identity_token:"Cognito returned an identity token that failed validation.",
  identity_signature:"Cognito token signature verification failed.",
  jwks_key:"The signing key wasn't found in the Cognito user pool.",
  jwks_fetch:"Cognito signing keys could not be retrieved.",
  jwks_network:"The server could not connect to the Cognito signing-key endpoint.",
  jwks_http_404:"Cognito returned HTTP 404 for its signing keys. Verify the Cognito user pool.",
  jwks_http_403:"Cognito refused access to its signing keys.",
  issuer_invalid:"The Cognito token contains an unexpected issuer.",
  client_secret:"Cognito client secret is not available.",
  missing_code:"No authorization code was returned.",
  session_secret_short:"The Elettro session signing secret is too short.",
  client_secret_read:"Unable to read the Cognito client secret in AWS.",
  session_secret_read:"Unable to read the Elettro session signing secret in AWS.",
  ssm_parameter_missing:"A required AWS parameter was not found.",
  ssm_access_denied:"AWS denied access to a required authentication parameter.",
  callback_unexpected:"An unexpected server error occurred while completing sign-in."
};
export default async function AuthenticationError({searchParams}:{searchParams:Promise<{reason?:string}>}) {
  const {reason}=await searchParams;
  const code=reason&&Object.hasOwn(descriptions,reason)?reason:"callback_unexpected";
  return <main style={{maxWidth:650,margin:"12vh auto",padding:28,fontFamily:"system-ui"}}>
    <h1>Elettro sign-in needs attention</h1>
    <p>{descriptions[code]}</p>
    <p>Diagnostic: <code>{code}</code></p>
    <p>The login has not completed. The redirect loop is stopped.</p>
    <Link href="/api/auth/login">Try signing in again</Link>
  </main>;
}
