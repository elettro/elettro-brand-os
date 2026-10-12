import { NextResponse } from "next/server";
import { AUTH_COOKIE, STATE_COOKIE, DEV_ORIGIN } from "@/lib/cognito-auth";
export async function GET() {
  const response=NextResponse.redirect(DEV_ORIGIN+"/");
  response.cookies.delete(AUTH_COOKIE);
  response.cookies.delete(STATE_COOKIE);
  return response;
}
