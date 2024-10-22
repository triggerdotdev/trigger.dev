import { auth, runs, tasks } from "@trigger.dev/sdk/v3";
import type { task1, zodTask } from "./trigger/taskTypes.js";
import { randomUUID } from "crypto";

async function main() {
  const userId = randomUUID();

  const anyHandle = await tasks.trigger<typeof task1>(
    "types/task-1",
    {
      foo: "baz",
    },
    {
      tags: [`user:${userId}`],
    },
    {
      publicAccessToken: {
        expirationTime: "24hr",
      },
    }
  );

  console.log("Auto JWT", anyHandle.publicAccessToken);

  const publicToken = await auth.createPublicToken({
    scopes: {
      read: {
        runs: true,
      },
    },
  });

  await auth.withAuth({ accessToken: anyHandle.publicAccessToken }, async () => {
    const subscription = runs.subscribeToRunsWithTag<typeof task1 | typeof zodTask>(
      `user:${userId}`
    );

    for await (const run of subscription) {
      switch (run.taskIdentifier) {
        case "types/task-1": {
          console.log("Run update:", run);
          console.log("Output:", run.output);
          console.log("Payload:", run.payload);
          break;
        }
        case "types/zod": {
          console.log("Run update:", run);
          console.log("Output:", run.output);
          console.log("Payload:", run.payload);
          break;
        }
      }
    }
  });
}

main().catch(console.error);
