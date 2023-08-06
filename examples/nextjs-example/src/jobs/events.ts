import { client } from "@/trigger";
import { Job, eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

client.defineJob({
  id: "test-event-trigger-1",
  name: "Test Event Trigger 1",
  version: "0.0.1",
  logLevel: "debug",
  trigger: eventTrigger({
    name: "test-event-trigger-1",
    schema: z.object({
      name: z.string(),
      payload: z.any(),
    }),
  }),
  run: async (payload, io, ctx) => {
    await io.sendEvent(
      "send",
      {
        name: payload.name,
        payload: payload.payload,
        timestamp: new Date(),
      },
      { deliverAt: new Date(Date.now() + 1000 * 30) }
    );
  },
});

client.defineJob({
  id: "test-event-trigger-2",
  name: "Test Event Trigger 2",
  version: "0.0.1",
  logLevel: "debug",
  trigger: eventTrigger({
    name: "test-event-trigger-2",
  }),
  run: async (payload, io, ctx) => {
    for (let index = 0; index < 100; index++) {
      await io.sendEvent(`send-${index}`, {
        name: "test-event-trigger-1",
        payload: { name: "whatever", payload: { index } },
      });
    }
  },
});

client.defineJob({
  id: "test-multiple-events",
  name: "Test Multiple Events",
  version: "0.0.1",
  logLevel: "debug",
  trigger: eventTrigger({
    name: ["test.event.1", "test.event.2"],
    examples: [{ id: "test", name: "Test", payload: { name: "test" } }],
  }),
  run: async (payload, io, ctx) => {
    await io.logger.log(`Triggered by the ${ctx.event.name} event`, { ctx });
  },
});
