import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";

export const triggerClient = new TriggerClient({
  id: "perf",
  apiKey: process.env.TRIGGER_API_KEY!,
  apiUrl: process.env.TRIGGER_API_URL!,
});

triggerClient.defineJob({
  id: `perf-test-1`,
  name: `Perf Test 1`,
  version: "1.0.0",
  trigger: eventTrigger({
    name: "perf.test",
  }),
  run: async (payload, io, ctx) => {
    await io.runTask("task-1", { name: "task 1" }, async (task) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));

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
