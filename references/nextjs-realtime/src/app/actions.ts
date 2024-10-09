"use server";

import { redirect } from "next/navigation";
import type { exampleTask } from "@/trigger/example";
import { auth, tasks } from "@trigger.dev/sdk/v3";
import { cookies } from "next/headers";

export async function triggerExampleTask() {
  const handle = await tasks.trigger<typeof exampleTask>("example", {
    foo: "bar",
  });

  const jwt = await auth.generateJWT({ permissions: [handle.id] });

  // Set JWT in a secure, HTTP-only cookie
  cookies().set("run_jwt", jwt);

  // Redirect to the details page
  redirect(`/runs/${handle.id}`);
}
