"use server";

import { tasks, batch, auth } from "@trigger.dev/sdk";
import type { simpleTask } from "@/trigger/simple-task";
import type { streamTask } from "@/trigger/stream-task";
import type { taggedTask } from "@/trigger/tagged-task";
import type { batchItemTask } from "@/trigger/batch-task";
import { redirect } from "next/navigation";

export async function triggerSimpleTask(message: string, duration?: number) {
  const handle = await tasks.trigger<typeof simpleTask>("simple-task", {
    message,
    duration,
  });

  redirect(`/run/${handle.id}?accessToken=${handle.publicAccessToken}`);
}

export async function triggerStreamTask(scenario: "text" | "json" | "mixed", count?: number) {
  const handle = await tasks.trigger<typeof streamTask>("stream-task", {
    scenario,
    count,
  });

  redirect(`/run-with-streams/${handle.id}?accessToken=${handle.publicAccessToken}`);
}

export async function triggerTaggedTask(userId: string, action: string, tags: string[]) {
  const handle = await tasks.trigger<typeof taggedTask>(
    "tagged-task",
    {
      userId,
      action,
    },
    {
      tags,
    }
  );

  const publicAccessToken = await auth.createPublicToken({
    scopes: {
      read: {
        tags: tags,
      },
    },
  });

  // Redirect to the tag page for the first tag
  const tag = tags[0] || "test";
  redirect(`/runs-with-tag/${tag}?accessToken=${publicAccessToken}`);
}

export async function triggerBatchTasks(itemCount: number) {
  const items = Array.from({ length: itemCount }, (_, i) => ({
    payload: {
      itemId: `item-${i + 1}`,
      value: Math.floor(Math.random() * 100) + 1,
    },
  }));

  const batchHandle = await tasks.batchTrigger<typeof batchItemTask>("batch-item-task", items);

  redirect(`/batch/${batchHandle.batchId}?accessToken=${batchHandle.publicAccessToken}`);
}

export async function triggerStreamOnlyTask() {
  const handle = await tasks.trigger<typeof streamTask>("stream-task", {
    scenario: "text",
    count: 30,
  });

  redirect(`/stream/${handle.id}?accessToken=${handle.publicAccessToken}`);
}
