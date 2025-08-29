import { logger, task } from "@trigger.dev/sdk";

import { Console, Effect, Schedule } from "effect";

const helloWorldIteration = Effect.gen(function* () {
  yield* Console.log(`Hello World!`);
  yield* Effect.sleep("1 second");
  yield* Console.log(`Done!`);
  return "Iteration completed";
});

// Repeat the effect 9 times (plus the initial run = 10 total)
const helloWorldLoop = helloWorldIteration.pipe(Effect.repeat(Schedule.recurs(9)));

export const effectTask = task({
  id: "effect",
  run: async () => {
    const result = await Effect.runPromise(Effect.scoped(helloWorldLoop));

    return result;
  },
  onSuccess: async () => {
    logger.info("Hello, world from the onSuccess hook");
  },
  onFailure: async () => {
    logger.info("Hello, world from the onFailure hook");
  },
  onCancel: async () => {
    logger.info("Hello, world from the onCancel hook");
  },
});

// Prevent SIGTERM from killing the process immediately
process.on("SIGTERM", () => {
  console.log("Received SIGTERM signal, but ignoring it...");
  // Process continues running
});
