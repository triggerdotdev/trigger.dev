import { RunTags } from "@trigger.dev/core/v3";
import { logger, runs, tags, task } from "@trigger.dev/sdk/v3";
import { simpleChildTask } from "./subtasks";

type Payload = {
  tags: RunTags;
};

export const triggerRunsWithTags = task({
  id: "trigger-runs-with-tags",
  run: async (payload: Payload, { ctx }) => {
    const { id } = await simpleChildTask.trigger(
      { message: "Hello from triggerRunsWithTags" },
      { tags: payload.tags }
    );

    const run = await runs.retrieve(id);
    logger.log("run", run);

    const result2 = await runs.list({ tag: payload.tags });
    logger.log("trigger runs ", { length: result2.data.length, data: result2.data });
  },
});
