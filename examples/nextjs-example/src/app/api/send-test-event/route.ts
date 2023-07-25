import { client } from "@/trigger";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const event = await client.sendEvent({
    name: "test-event",
  });

  return NextResponse.json(event);
}
