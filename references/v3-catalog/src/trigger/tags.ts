import { logger, runs, task, tasks } from "@trigger.dev/sdk/v3";
import { simpleChildTask } from "./subtasks.js";

type Payload = {
  tags: string | string[];
};

export const triggerRunsWithTags = task({
  id: "trigger-runs-with-tags",
  run: async (payload: Payload, { ctx }) => {
    logger.info(`${ctx.run.version}`);

    const { id } = await simpleChildTask.trigger(
      { message: "trigger from triggerRunsWithTags foobar" },
      { tags: payload.tags }
    );

    //runs in the past 5 seconds, as a date
    const from = new Date();
    from.setSeconds(from.getSeconds() - 5);
    const result2 = await runs.list({ tag: payload.tags, from });
    logger.log("list with Date()", { length: result2.data.length, data: result2.data });

    //runs in the past 5 seconds, as a number timestamp
    const result3 = await runs.list({ tag: payload.tags, from: from.getTime() - 5000 });
    logger.log("list with timestamp", { length: result3.data.length, data: result3.data });

    logger.log("run usage", {
      costInCents: result2.data[0].costInCents,
      baseCostInCents: result2.data[0].baseCostInCents,
      durationMs: result2.data[0].durationMs,
    });

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

    return {
      tags: run.tags,
    };
  },
});
