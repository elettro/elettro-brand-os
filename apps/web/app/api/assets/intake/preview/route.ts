import { NextRequest, NextResponse } from "next/server";
import { normalizeIntakeBatch, validateIntakeBatch, type IntakeBatchInput } from "@elettro/database";

export async function POST(request: NextRequest) {
  const input = (await request.json()) as IntakeBatchInput;
  const errors = validateIntakeBatch(input);

  if (errors.length) {
    return NextResponse.json({ ok: false, errors }, { status: 400 });
  }

  try {
    const normalized = normalizeIntakeBatch(input);
    return NextResponse.json({ ok: true, normalized });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        errors: [error instanceof Error ? error.message : "Invalid intake metadata"]
      },
      { status: 400 }
    );
  }
}
