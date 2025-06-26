import { auth, logger, runs, task, tasks } from "@trigger.dev/sdk";
import { helloWorldTask } from "./example.js";
import { setTimeout } from "timers/promises";

export const realtimeByTagsTask = task({
  id: "realtime-by-tags",
  run: async (payload: any, { ctx, signal }) => {
    const triggerToken = await auth.createTriggerPublicToken("hello-world", {
      expirationTime: "1h",
      realtime: {
        skipColumns: ["payload", "output"],
      },
    });

    logger.info("triggerToken", { triggerToken });

    const handle = await auth.withAuth({ accessToken: triggerToken }, async () => {
      return await tasks.trigger("hello-world", {
        hello: "world",
        sleepFor: 1000,
      });
    });

    logger.info("handle token", {
      publicAccessToken: handle.publicAccessToken,
    });

    await auth.withAuth({ accessToken: handle.publicAccessToken }, async () => {
      for await (const run of runs.subscribeToRun(handle.id, { stopOnCompletion: true })) {
        logger.info("run", { run });
      }
    });

    return {
      message: "Hello, world!",
    };
  },
});

export const realtimeUpToDateTask = task({
  id: "realtime-up-to-date",
  run: async ({ runId }: { runId?: string }) => {
    if (!runId) {
      const handle = await helloWorldTask.trigger(
        { hello: "world" },
        {
          tags: ["hello-world", "realtime"],
        }
      );

      runId = handle.id;
    }

    logger.info("runId", { runId });

    for await (const run of runs.subscribeToRun(runId, { stopOnCompletion: true })) {
      logger.info("run", { run });
    }

    return {
      message: "Hello, world!",
    };
  },
});
