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
  id: "stress-test-1",
  name: "Stress Test 1",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "stress.test.1",
  }),
  run: async (payload, io, ctx) => {
    // Run 10 tasks, each with a 300KB output
    for (let i = 0; i < 10; i++) {
      await io.runTask(`task-${i}`, { name: `Task ${i}` }, async (task) => {
        return {
          output: "a".repeat(300 * 1024),
        };
      });
    }

    // Now run a single task with 5MB output
    await io.runTask(`task-5mb`, { name: `Task 5MB` }, async (task) => {
      return {
        output: "a".repeat(5 * 1024 * 1024),
      };
    });

    // Now do a wait for 5 seconds
    await io.wait("wait", 5);
  },
});

createExpressServer(client);
