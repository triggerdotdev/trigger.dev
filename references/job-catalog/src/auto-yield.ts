import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: true,
  ioLogLocalEnabled: true,
});

client.defineJob({
  id: "auto-yield-1",
  name: "Auto Yield 1",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "auto.yield.1",
  }),
  run: async (payload, io, ctx) => {
    await io.runTask("initial-long-task", async (task) => {
      await new Promise((resolve) => setTimeout(resolve, 51000)); // 51 seconds

      return {
        message: "initial-long-task",
      };
    });

    for (let i = 0; i < payload.iterations; i++) {
      await io.runTask(`task.${i}`, async (task) => {
        // Create a random number between 250 and 1250
        const random = Math.floor(Math.random() * 1000) + 250;

        await new Promise((resolve) => setTimeout(resolve, random));

        await fetch(payload.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: `task.${i}`,
            random,
            idempotencyKey: task.idempotencyKey,
            runId: ctx.run.id,
          }),
        });

        return {
          message: `task.${i}`,
          random,
        };
      });
    }
  },
});

client.defineJob({
  id: "auto-yield-2",
  name: "Auto Yield 2",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "auto.yield.2",
  }),
  run: async (payload, io, ctx) => {
    await io.runTask("long-task-1", async (task) => {
      await new Promise((resolve) => setTimeout(resolve, 10000));

      return {
        message: "long-task-1",
      };
    });

    await io.runTask("long-task-2", async (task) => {
      await new Promise((resolve) => setTimeout(resolve, 10000));

      return {
        message: "long-task-2",
      };
    });
  },
});

createExpressServer(client);
