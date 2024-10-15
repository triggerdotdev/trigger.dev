import { runs, tasks, auth, AnyTask, Task } from "@trigger.dev/sdk/v3";
import type { task1, task2 } from "./trigger/taskTypes.js";

async function main() {
  const anyHandle = await tasks.trigger<typeof task1>("types/task-1", {
    foo: "baz",
  });

  const jwt = await auth.generateJWT({ permissions: [anyHandle.id] });

  console.log("Generated JWT:", jwt);

  // The JWT will be passed to the client
  await auth.context({ accessToken: jwt }, async () => {
    const subscription = runs.subscribeToTag<typeof task1 | typeof task2>("user:1234");

    for await (const run of subscription) {
      switch (run.taskIdentifier) {
        case "types/task-1": {
          console.log("Run update:", run);
          console.log("Output:", run.output);
          console.log("Payload:", run.payload);
          break;
        }
        case "types/task-2": {
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
