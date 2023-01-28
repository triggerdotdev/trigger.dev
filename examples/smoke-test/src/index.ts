import { z } from "zod";
import { Trigger, customEvent, sendEvent } from "@trigger.dev/sdk";
import { ulid } from "ulid";

const userCreatedEvent = z.object({
  id: z.string(),
});

const trigger = new Trigger({
  id: "my-workflow",
  name: "My workflow",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  triggerTTL: 60 * 60 * 24,
  on: customEvent({ name: "user.created", schema: userCreatedEvent }),
  run: async (event, ctx) => {
    await ctx.logger.info("Inside the smoke test workflow, received event", {
      event,
      myDate: new Date(),
    });

    await ctx.sendEvent("start-fire", {
      name: "smoke.test",
      payload: { baz: "banana" },
      delay: { until: new Date(Date.now() + 1000 * 60) },
    });

    await sendEvent("start-fire-2", {
      name: "smoke.test2",
      payload: { baz: "banana2" },
      delay: { minutes: 1 },
    });

    return { foo: "bar" };
  },
});

trigger.listen();

new Trigger({
  id: "smoke-test",
  name: "Smoke Test",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "smoke.test",
    schema: z.object({ baz: z.string() }),
  }),
  run: async (event, ctx) => {
    await ctx.logger.info("Inside the smoke test workflow, received event", {
      event,
      myDate: new Date(),
    });
  },
}).listen();

new Trigger({
  id: "log-tests",
  name: "My logs",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({ name: "user.created", schema: z.any() }),
  run: async (event, ctx) => {
    await ctx.logger.info("It's been 5 minutes since the last run!");
    await ctx.logger.debug("This is a debug log");
    await ctx.logger.warn("This is a warning");
    await ctx.logger.error("This is an error");
  },
}).listen();
