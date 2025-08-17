import { NextResponse } from "next/server";

export async function POST(request: Request) {
  return NextResponse.json({ body: "Hello, world!" });
}
