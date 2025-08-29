import { logger, runs, task } from "@trigger.dev/sdk";

export const sdkMethods = task({
  id: "sdk-methods",
  run: async (payload: any, { ctx }) => {
    for await (const run of runs.list({
      status: ["COMPLETED"],
      from: new Date(Date.now() - 1000 * 60 * 60), // 1 hour ago
      to: new Date(), // now
    })) {
      logger.info("completed run", { run });
    }

    for await (const run of runs.list({
      status: ["FAILED"],
      from: new Date(Date.now() - 1000 * 60 * 60), // 1 hour ago
      to: new Date(), // now
      limit: 50,
    })) {
      logger.info("failed run", { run });
    }

    for await (const run of runs.list({
      queue: { type: "task", name: "sdk-methods" },
      limit: 5,
    })) {
      logger.info("sdk-methods run", { run });
    }

    for await (const run of runs.list({
      machine: ["small-1x", "small-2x"],
      limit: 5,
    })) {
      logger.info("small machine run", { run });
    }

    return runs;
  },
});
