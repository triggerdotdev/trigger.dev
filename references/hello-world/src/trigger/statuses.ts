import { logger, runs, task } from "@trigger.dev/sdk";

export const statusesTest = task({
  id: "statuses-test",
  run: async () => {
    console.log("statusesTest");
  },
});

export const subscribeToRun = task({
  id: "subscribe-to-run",
  run: async (payload: { runId: string }) => {
    const subscription = runs.subscribeToRun(payload.runId, {
      stopOnCompletion: false,
    });

    for await (const event of subscription) {
      logger.info("run event", { event });
    }
  },
});

export const retrieveRun = task({
  id: "retrieve-run",
  run: async (payload: { runId: string }) => {
    const run = await runs.retrieve(payload.runId);
    logger.info("run", { run });
  },
});
