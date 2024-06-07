import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

client.defineJob({
  id: "event-example-1",
  name: "Event Example 1",
  version: "1.0.0",
  enabled: true,
  trigger: eventTrigger({
    name: "event.example",
  }),
  run: async (payload, io, ctx) => {
    await io.runTask(
      "task-example-1",
      async () => {
        return {
          message: "Hello World",
        };
      },
      { icon: "360" }
    );

    await io.wait("wait-1", 1);

    await io.logger.info("Hello World", { ctx });
  },
});

client.defineJob({
  id: "cancel-event-example",
  name: "Cancel Event Example",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "cancel.event.example",
  }),
  run: async (payload, io, ctx) => {
    const event = await io.sendEvent(
      "send-event",
      { name: "Cancellable Event", id: payload.id, payload: { payload, ctx } },
      {
        deliverAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24 hours from now
      }
    );

    await io.getEvent("get-event", event.id);

    await io.wait("wait-1", 60); // 1 minute

    await io.cancelEvent("cancel-event", event.id);

    await io.getEvent("get-event-2", event.id);
  },
});

client.defineJob({
  id: "zod-schema",
  name: "Job with Zod Schema",
  version: "0.0.2",
  trigger: eventTrigger({
    name: "zod.schema",
    schema: z.object({
      userId: z.string(),
      delay: z.number(),
    }),
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("Hello World", { ctx, payload });
  },
});

client.defineJob({
  id: "no-real-task",
  name: "No real Task",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "no.real.task",
    schema: z.object({
      userId: z.string(),
    }),
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("Hello World", { ctx, payload });
    await io.wait("Wait 1 sec", 1);
    //this is a real task
    // await io.runTask("task-example-1", async () => {
    //   return {
    //     message: "Hello World",
    //   };
    // });
  },
});

client.defineJob({
  id: "cancel-runs-example",
  name: "Cancel Runs Example",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "cancel.runs.example",
  }),
  run: async (payload, io, ctx) => {
    const event = await io.sendEvent("send-event", {
      name: "foo.bar",
      id: payload.id,
      payload: { payload, ctx },
    });

    await io.wait("wait-1", 1); // 1 second

    await io.runTask("cancel-runs", async () => {
      return await client.cancelRunsForEvent(event.id);
    });
  },
});

client.defineJob({
  id: "foo-bar-example",
  name: "Foo Bar Example",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "foo.bar",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("Hello World", { ctx, payload });

    await io.wait("wait-1", 10); // 10 seconds

    await io.logger.info("Hello World 2", { ctx, payload });
  },
});

client.defineJob({
  id: "foo-bar-example-2",
  name: "Foo Bar Example 2",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "foo.bar",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("Hello World", { ctx, payload });

    await io.wait("wait-1", 10); // 10 seconds

    await io.logger.info("Hello World 2", { ctx, payload });
  },
});

client.defineJob({
  id: "retry-with-failed-errors",
  name: "Retry with failed errors",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "foo.bar",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("Hello World", { ctx, payload });

    return await io.runTask("task-example-1", async () => {
      if (Math.random() > 0.5) {
        throw new Error("Failed on purpose");
      }

      return {
        message: "Hello World",
      };
    });
  },
});

client.defineJob({
  id: "same-event-id",
  name: "Save event id",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "same.event.id",
  }),
  run: async (payload: { id: string }, io, ctx) => {
    const event = await io.sendEvent("send-event", {
      name: "same.event.child",
      id: payload.id,
      payload: { payload, ctx },
    });

    const event2 = await io.sendEvent("send-event-2", {
      name: "same.event.child",
      id: payload.id,
      payload: { payload, ctx },
    });
  },
});

client.defineJob({
  id: "same-event-id-child",
  name: "Save event id: child",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "same.event.child",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info(`payloadId: ${payload.id}`);
  },
});

createExpressServer(client);
