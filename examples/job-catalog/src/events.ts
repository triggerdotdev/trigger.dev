import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";

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
  trigger: eventTrigger({
    name: "event.example",
  }),
  run: async (payload, io, ctx) => {
    await io.runTask("task-example-1", { name: "Task 1" }, async () => {
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
      { name: "Cancellable Event", id: payload.id },
      {
        deliverAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24 hours from now
      }
    );

    await io.wait("wait-1", 60); // 1 minute

    await io.cancelEvent("cancel-event", payload.id);
  },
});

createExpressServer(client);
