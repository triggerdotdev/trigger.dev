import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk";
import type { todoChat } from "@/trigger/chat";

export async function POST(request: Request) {
  const body = await request.json();

  const handle = await tasks.batchTrigger<typeof todoChat>("todo-chat", [
    {
      payload: {
        input: body.input,
        userId: "123",
      },
    },
  ]);

  return NextResponse.json({ handle });
}
