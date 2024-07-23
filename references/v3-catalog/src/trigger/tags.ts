import { RunTags } from "@trigger.dev/core/v3";
import { logger, runs, tags, task, tasks } from "@trigger.dev/sdk/v3";
import { simpleChildTask } from "./subtasks";

type Payload = {
  tags: RunTags;
};

export const triggerRunsWithTags = task({
  id: "trigger-runs-with-tags",
  run: async (payload: Payload, { ctx }) => {
    const { id } = await simpleChildTask.trigger(
      { message: "trigger from triggerRunsWithTags" },
      { tags: payload.tags }
    );

    await simpleChildTask.triggerAndWait(
      { message: "triggerAndWait from triggerRunsWithTags" },
      { tags: payload.tags }
    );

    await simpleChildTask.batchTrigger([
      {
        payload: { message: "batchTrigger 1 from triggerRunsWithTags" },
        options: { tags: payload.tags },
      },
      {
        payload: { message: "batchTrigger 2 from triggerRunsWithTags" },
        options: { tags: payload.tags },
      },
    ]);

    const results = await simpleChildTask.batchTriggerAndWait([
      {
        payload: { message: "batchTriggerAndWait 1 from triggerRunsWithTags" },
        options: { tags: payload.tags },
      },
      {
        payload: { message: "batchTriggerAndWait 2 from triggerRunsWithTags" },
        options: { tags: payload.tags },
      },
    ]);

    await tasks.trigger<typeof simpleChildTask>(
      "simple-child-task",
      { message: "tasks.trigger from triggerRunsWithTags" },
      { tags: payload.tags }
    );
    await tasks.triggerAndWait<typeof simpleChildTask>(
      "simple-child-task",
      { message: "tasks.triggerAndWait from triggerRunsWithTags" },
      { tags: payload.tags }
    );
    await tasks.batchTrigger<typeof simpleChildTask>("simple-child-task", [
      {
        payload: { message: "tasks.batchTrigger 1 from triggerRunsWithTags" },
        options: { tags: payload.tags },
      },
      {
        payload: { message: "tasks.batchTrigger 2 from triggerRunsWithTags" },
        options: { tags: payload.tags },
      },
    ]);

    const run = await runs.retrieve(id);
    logger.log("run", run);
    logger.log("run usage", {
      costInCents: run.costInCents,
      baseCostInCents: run.baseCostInCents,
      durationMs: run.durationMs,
    });

    const result2 = await runs.list({ tag: payload.tags });
    logger.log("trigger runs ", { length: result2.data.length, data: result2.data });
    logger.log("run usage", {
      costInCents: result2.data[0].costInCents,
      baseCostInCents: result2.data[0].baseCostInCents,
      durationMs: result2.data[0].durationMs,
    });
  },
});
