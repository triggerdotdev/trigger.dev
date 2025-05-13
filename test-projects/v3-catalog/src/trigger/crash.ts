import { logger, task } from "@trigger.dev/sdk/v3";

type Payload = {};

export const crashparent = task({
  id: "crashparent",
  run: async (payload: Payload, { ctx }) => {
    logger.log("crashparent started");

    const result = await crash.triggerAndWait({});
    logger.log("crashparent done", { result });

    const results = await crash.batchTriggerAndWait([
      { payload: {} },
      { payload: {} },
      { payload: {} },
      { payload: {} },
      { payload: {} },
    ]);
    logger.log("crashparent batch done", { results });
  },
});

export const crash = task({
  id: "crash",
  run: async (payload: Payload, { ctx }) => {
    logger.log(`${ctx.run.version}`);

    process.exit(1);

    return {
      foo: "bar",
    };
  },
});
