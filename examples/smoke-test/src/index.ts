import { z } from "zod";
import { Trigger, customEvent } from "@trigger.dev/sdk";

const userCreatedEvent = z.object({
  id: z.string(),
});

const trigger = new Trigger({
  id: "my-workflow",
  name: "My workflow",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({ name: "user.created", schema: userCreatedEvent }),
  run: async (event, ctx) => {
    await ctx.logger.info("Inside the smoke test workflow, received event", {
      event,
      myDate: new Date(),
    });

    await ctx.fireEvent("start-fire", {
      name: "smoke.test",
      payload: { baz: "banana" },
    });

    return { foo: "bar" };
  },
});

trigger.listen();
