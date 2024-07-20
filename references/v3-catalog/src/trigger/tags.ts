import { RunTags } from "@trigger.dev/core/v3";
import { logger, runs, task } from "@trigger.dev/sdk/v3";
import { simpleChildTask } from "./subtasks";

type Payload = {
  tags: RunTags;
};

export const triggerRunsWithTags = task({
  id: "trigger-runs-with-tags",
  run: async (payload: Payload) => {
    const { id } = await simpleChildTask.trigger(
      { message: "Hello from triggerRunsWithTags" },
      { tags: payload.tags }
    );

    const run = await runs.retrieve(id);
    logger.log("run", run);

    const result = await runs.list({ tag: payload.tags });
    logger.log("result", { length: result.data.length, data: result.data });
  },
});
