import { NextResponse } from "next/server";
import { CALLBACK, COGNITO_CLIENT_ID, COGNITO_DOMAIN, STATE_COOKIE, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
export const runtime = "nodejs";
export async function GET() {
  try {
    const state = challenge();
    const url = new URL(COGNITO_DOMAIN + "/oauth2/authorize");
    url.searchParams.set("client_id", COGNITO_CLIENT_ID);
    url.searchParams.set("redirect_uri", CALLBACK);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email");
    url.searchParams.set("state", state);
    const response = NextResponse.redirect(url);
    response.cookies.set(STATE_COOKIE, await seal(state), cookieSettings(600));
    return response;
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error("Elettro DEV Cognito login setup failure", name);
    const category = name === "AccessDeniedException" || name === "AccessDenied" ? "ssm_access_denied" : name === "ParameterNotFound" ? "ssm_parameter_not_found" : name === "CredentialsProviderError" ? "aws_credentials_unavailable" : name === "ValidationException" ? "ssm_parameter_invalid" : "auth_secret_unavailable";
    return NextResponse.json({ error: "Login setup cannot access its server-side session key", diagnostic: category }, { status: 503 });
  }
}
