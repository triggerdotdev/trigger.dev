"use server";

import type { exampleTask } from "@/trigger/example";
import { auth, tasks } from "@trigger.dev/sdk/v3";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";

export async function triggerExampleTask() {
  const handle = await tasks.trigger<typeof exampleTask>("example", {
    id: randomUUID(),
  });

  // Set JWT in a secure, HTTP-only cookie
  cookies().set("run_token", handle.publicAccessToken);

  // Redirect to the details page
  redirect(`/runs/${handle.id}`);
}

export async function batchTriggerExampleTask() {
  console.log("Batch trigger example task");

  const handle = await tasks.batchTrigger<typeof exampleTask>("example", [
    { payload: { id: randomUUID() } },
    { payload: { id: randomUUID() } },
    { payload: { id: randomUUID() } },
    { payload: { id: randomUUID() } },
    { payload: { id: randomUUID() } },
    { payload: { id: randomUUID() } },
    { payload: { id: randomUUID() } },
    { payload: { id: randomUUID() } },
  ]);

  console.log("Setting the run JWT in a cookie", handle.publicAccessToken);

  // Set JWT in a secure, HTTP-only cookie
  cookies().set("run_token", handle.publicAccessToken);

  // Redirect to the details page
  redirect(`/batches/${handle.batchId}`);
}
