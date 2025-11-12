"use server";

import { tasks, auth } from "@trigger.dev/sdk";
import type { streamsTask } from "@/trigger/streams";
import type { aiChatTask } from "@/trigger/ai-chat";
import { redirect } from "next/navigation";
import type { UIMessage } from "ai";

export async function triggerStreamTask(
  scenario: string,
  redirectPath?: string,
  useDurableStreams?: boolean
) {
  const config = useDurableStreams
    ? {
        future: {
          v2RealtimeStreams: true,
        },
      }
    : undefined;

  // Trigger the streams task
  const handle = await tasks.trigger<typeof streamsTask>(
    "streams",
    {
      scenario: scenario as any,
    },
    {},
    {
      clientConfig: config,
    }
  );

  // Redirect to custom path or default run page
  const path = redirectPath
    ? `${redirectPath}/${handle.id}?accessToken=${handle.publicAccessToken}&isMarkdown=${
        scenario === "markdown" ? "true" : "false"
      }`
    : `/runs/${handle.id}?accessToken=${handle.publicAccessToken}&isMarkdown=${
        scenario === "markdown" ? "true" : "false"
      }`;

  redirect(path);
}

export async function triggerAIChatTask(messages: UIMessage[]) {
  // Trigger the AI chat task
  const handle = await tasks.trigger<typeof aiChatTask>(
    "ai-chat",
    {
      messages,
    },
    {},
    {
      clientConfig: {
        future: {
          v2RealtimeStreams: true,
        },
      },
    }
  );

  console.log("Triggered AI chat run:", handle.id);

  // Redirect to chat page
  redirect(`/chat/${handle.id}?accessToken=${handle.publicAccessToken}`);
}
