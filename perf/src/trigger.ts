import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";

export const triggerClient = new TriggerClient({
  id: "perf",
  apiKey: process.env.TRIGGER_API_KEY!,
  apiUrl: process.env.TRIGGER_API_URL!,
});

const concurrencyLimit = triggerClient.defineConcurrencyLimit({
  id: `perf-test-shared`,
  limit: 5,
});

triggerClient.defineJob({
  id: `perf-test-1`,
  name: `Perf Test 1`,
  version: "1.0.0",
  trigger: eventTrigger({
    name: "perf.test",
  }),
  concurrencyLimit,
  run: async (payload, io, ctx) => {
    await io.runTask(
      "task-1",
      async (task) => {
        await new Promise((resolve) => setTimeout(resolve, 5000));

        return {
          value: Math.random(),
        };
      },
      { name: "task 1" }
    );

    await io.wait("wait", 10);

    await io.runTask(
      "task-2",
      async (task) => {
        return {
          value: Math.random(),
        };
      },
      { name: "task 2" }
    );

    await io.runTask(
      "task-3",
      async (task) => {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        return {
          value: Math.random(),
        };
      },
      { name: "task 3" }
    );
  },
});

triggerClient.defineJob({
  id: `perf-test-2`,
  name: `Perf Test 2`,
  version: "1.0.0",
  trigger: eventTrigger({
    name: "perf.test",
  }),
  concurrencyLimit: 5,
  run: async (payload, io, ctx) => {
    await io.runTask(
      "task-1",
      async (task) => {
        await new Promise((resolve) => setTimeout(resolve, 5000));

        return {
          value: Math.random(),
        };
      },
      { name: "task 1" }
    );

    await io.wait("wait", 10);

    await io.runTask(
      "task-2",
      async (task) => {
        return {
          value: Math.random(),
        };
      },
      { name: "task 2" }
    );

    await io.runTask(
      "task-3",
      async (task) => {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        return {
          value: Math.random(),
        };
      },
      { name: "task 3" }
    );
  },
});

triggerClient.defineJob({
  id: `perf-test-3`,
  name: `Perf Test 3`,
  version: "1.0.0",
  trigger: eventTrigger({
    name: "perf.test",
  }),
  concurrencyLimit,
  run: async (payload, io, ctx) => {
    await io.runTask(
      "task-1",
      async (task) => {
        await new Promise((resolve) => setTimeout(resolve, 5000));

        return {
          value: Math.random(),
        };
      },
      { name: "task 1" }
    );

    await io.wait("wait", 10);

    await io.runTask(
      "task-2",
      async (task) => {
        return {
          value: Math.random(),
        };
      },
      { name: "task 2" }
    );

    await io.runTask(
      "task-3",
      async (task) => {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        return {
          value: Math.random(),
        };
      },
      { name: "task 3" }
    );
  },
});
