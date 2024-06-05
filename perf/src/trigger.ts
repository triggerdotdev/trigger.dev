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
    await io.runTask(
      "task-1",
      async (task) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          value: Math.random(),
        };
      },
      { name: "task 1" }
    );

    await io.wait("wait", 1);

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
        await new Promise((resolve) => setTimeout(resolve, 1000));

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
  concurrencyLimit: 3,
  run: async (payload, io, ctx) => {
    await io.runTask(
      "task-1",
      async (task) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          value: Math.random(),
        };
      },
      { name: "task 1" }
    );

    await io.wait("wait", 1);

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
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          value: Math.random(),
        };
      },
      { name: "task 3" }
    );
  },
});

const concurrencyLimit = triggerClient.defineConcurrencyLimit({
  id: `test-shared`,
  limit: 5, // Limit all jobs in this group to 5 concurrent executions
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
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          value: Math.random(),
        };
      },
      { name: "task 1" }
    );

    await io.wait("wait", 1);

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
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          value: Math.random(),
        };
      },
      { name: "task 3" }
    );
  },
});

triggerClient.defineJob({
  id: `perf-test-4`,
  name: `Perf Test 4`,
  version: "1.0.0",
  trigger: eventTrigger({
    name: "perf.test",
  }),
  concurrencyLimit,
  run: async (payload, io, ctx) => {
    await io.runTask(
      "task-1",
      async (task) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          value: Math.random(),
        };
      },
      { name: "task 1" }
    );

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
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          value: Math.random(),
        };
      },
      { name: "task 3" }
    );
  },
});
