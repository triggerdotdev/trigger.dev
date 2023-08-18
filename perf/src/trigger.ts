import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

export const triggerClient = new TriggerClient({
  id: "perf",
  apiKey: process.env.TRIGGER_API_KEY!,
  apiUrl: process.env.TRIGGER_API_URL!,
});

// Define 10 jobs in a for loop
for (let i = 0; i < 10; i++) {
  triggerClient.defineJob({
    id: `perf-test-${i + 1}`,
    name: `Perf Test ${i + 1}`,
    version: "1.0.0",
    trigger: eventTrigger({
      name: "perf.test",
    }),
    queue: {
      name: "perf-test",
      maxConcurrent: 50,
    },
    run: async (payload, io, ctx) => {
      await io.runTask("task-1", { name: "task 1" }, async (task) => {
        return {
          value: Math.random(),
        };
      });

      await io.runTask("task-2", { name: "task 2" }, async (task) => {
        return {
          value: Math.random(),
        };
      });
    },
  });
}
