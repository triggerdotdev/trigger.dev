import { logger, runs, task } from "@trigger.dev/sdk";
import { helloWorldTask } from "./example.js";

export const realtimeByTagsTask = task({
  id: "realtime-by-tags",
  run: async (payload: any, { ctx, signal }) => {
    await helloWorldTask.trigger(
      { hello: "world" },
      {
        tags: ["hello-world", "realtime"],
      }
    );

    const timeoutSignal = AbortSignal.timeout(10000);

    const $signal = AbortSignal.any([signal, timeoutSignal]);

    $signal.addEventListener("abort", () => {
      logger.info("signal aborted");
    });

    for await (const run of runs.subscribeToRunsWithTag(
      "hello-world",
      { createdAt: "2m", skipColumns: ["payload", "output", "number"] },
      { signal: $signal }
    )) {
      logger.info("run", { run });
    }

    return {
      message: "Hello, world!",
    };
  },
});
