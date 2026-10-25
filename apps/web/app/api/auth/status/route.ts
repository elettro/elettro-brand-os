import { NextResponse } from "next/server";
import { session } from "@/lib/cognito-auth";
export const runtime="nodejs";
export async function GET() {
  const who=await session();
  return NextResponse.json({authenticated:!!who?.owner,signedIn:!!who,owner:!!who?.owner,brands:who?.owner?null:who?.brands??[]},{headers:{"cache-control":"no-store"}});
}
