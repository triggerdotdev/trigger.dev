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
    await io.runTask("task-example-1", async () => {
      return {
        message: "Hello World",
      };
    });

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
    await io.sendEvent(
      "send-event",
      { name: "Cancellable Event", id: payload.id, payload: { payload, ctx } },
      {
        deliverAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24 hours from now
      }
    );

    await io.getEvent("get-event", payload.id);

    await io.wait("wait-1", 60); // 1 minute

    await io.cancelEvent("cancel-event", payload.id);

    await io.getEvent("get-event-2", payload.id);
  },
});

client.defineJob({
  id: "example-job",
  name: "Example Job: a joke with a delay",
  version: "0.0.2",
  trigger: eventTrigger({
    name: "shayan.event",
    schema: z.object({
      userId: z.string(),
      delay: z.number(),
    }),
  }),
  run: async (payload, io, ctx) => {
    await io.wait("sleeping", payload.delay);

    await io.runTask(
      "init",
      async () => {
        console.log("init function ran", payload.userId);
      },
      { name: "init" }
    );

    await io.runTask(
      "failable",
      async (task) => {
        if (task.attempts > 2) {
          console.log("task succeeded");
          return {
            ok: true,
          };
        }
        console.log("task failed");
        throw new Error(`Task failed on ${task.attempts} attempt(s)`);
      },
      { name: "task-1", retry: { limit: 3 } }
    );

    await io.runTask(
      "log",
      async () => {
        console.log("hello from the job", payload.userId);
      },
      {
        name: "log",
      }
    );
  },
});

createExpressServer(client);
