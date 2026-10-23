import { NextResponse } from "next/server";
import { CALLBACK, COGNITO_CLIENT_ID, COGNITO_DOMAIN, STATE_COOKIE, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const state = challenge();
    const url = new URL(COGNITO_DOMAIN + "/oauth2/authorize");
    url.searchParams.set("client_id", COGNITO_CLIENT_ID);
    url.searchParams.set("redirect_uri", CALLBACK);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email");
    url.searchParams.set("state", state);
    // Optional email typed on the public page; Cognito pre-fills it. Anything that is not a plain email is dropped.
    const hint = (new URL(request.url).searchParams.get("login_hint") || "").trim();
    if (hint.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(hint)) url.searchParams.set("login_hint", hint);
    const response = NextResponse.redirect(url);
    response.cookies.set(STATE_COOKIE, await seal(state), cookieSettings(600));
    return response;
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : "";
    console.error("Elettro DEV Cognito login setup failure", name, message.replace(/[^a-zA-Z0-9 _-]/g,"").slice(0,120));
    const category = name === "AccessDeniedException" || name === "AccessDenied" ? "ssm_access_denied" : name === "ParameterNotFound" ? "ssm_parameter_not_found" : name === "CredentialsProviderError" ? "aws_credentials_unavailable" : name === "ValidationException" ? "ssm_parameter_invalid" : message === "Session signing key is too short" ? "session_secret_too_short" : message.includes("unavailable to the server") ? "session_secret_empty" : message.includes("DEV only") ? "wrong_branch_environment" : "auth_secret_unavailable";
    return NextResponse.json({ error: "Login setup cannot access its server-side session key", diagnostic: category }, { status: 503 });
  }
}
