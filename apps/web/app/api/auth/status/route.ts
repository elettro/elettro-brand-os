import { NextResponse } from "next/server";
import { ownerEmail, session } from "@/lib/cognito-auth";
export const runtime="nodejs";
export async function GET() {
  const who=await session();
  return NextResponse.json({authenticated:!!who?.owner,signedIn:!!who,owner:!!who?.owner,superAdmin:!!who?.owner&&who.email.toLowerCase()===ownerEmail(),brands:who?.owner?null:who?.brands??[]},{headers:{"cache-control":"no-store"}});
}
