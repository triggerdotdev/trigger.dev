import { logger, schedules, task } from "@trigger.dev/sdk/v3";
import { simpleChildTask } from "./subtasks";
import { RunTags } from "@trigger.dev/core/v3";

type Payload = {
  tags: RunTags;
};

export const triggerRunsWithTags = task({
  id: "trigger-runs-with-tags",
  run: async (payload: Payload) => {
    await simpleChildTask.trigger(
      { message: "Hello from triggerRunsWithTags" },
      { tags: payload.tags }
    );
  },
});
