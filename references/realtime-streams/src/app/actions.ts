"use server";

import { tasks, auth } from "@trigger.dev/sdk";
import type { streamsTask } from "@/trigger/streams";
import { redirect } from "next/navigation";

export async function triggerStreamTask(
  scenario: string,
  redirectPath?: string,
  useDurableStreams?: boolean
) {
  const config = useDurableStreams
    ? {
        future: {
          unstable_v2RealtimeStreams: true,
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

  console.log("Triggered run:", handle.id);

  // Redirect to custom path or default run page
  const path = redirectPath
    ? `${redirectPath}/${handle.id}?accessToken=${handle.publicAccessToken}`
    : `/runs/${handle.id}?accessToken=${handle.publicAccessToken}`;

  redirect(path);
}
