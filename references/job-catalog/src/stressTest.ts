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
  id: "stress-test-1",
  name: "Stress Test 1",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "stress.test.1",
  }),
  run: async (payload, io, ctx) => {
    // Run 10 tasks, each with a 300KB output
    for (let i = 0; i < 10; i++) {
      await io.runTask(
        `task-${i}`,
        async (task) => {
          return {
            output: "a".repeat(300 * 1024),
          };
        },
        { name: `Task ${i}` }
      );
    }

    // Now run a single task with 5MB output
    await io.runTask(
      `task-5mb`,
      async (task) => {
        return {
          output: "a".repeat(5 * 1024 * 1024),
        };
      },
      { name: `Task 5MB` }
    );

    // Now do a wait for 5 seconds
    await io.wait("wait", 5);
  },
});

client.defineJob({
  id: "stress-test-2",
  name: "Stress Test 2",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "stress.test.2",
  }),
  run: async (payload, io, ctx) => {
    await io.runTask(
      `task-1`,
      async (task) => {
        const response = await fetch("https://jsonplaceholder.typicode.com/photos");
        return await response.json();
      },
      { name: `Task 1` }
    );

    await io.runTask(
      `task-2`,
      async (task) => {
        const response = await fetch("https://jsonplaceholder.typicode.com/comments");
        return await response.json();
      },
      { name: `Task 2` }
    );

    await io.runTask(
      `task-3`,
      async (task) => {
        const response = await fetch("https://jsonplaceholder.typicode.com/photos");

        return await response.json();
      },
      { name: `Task 3` }
    );

    await io.runTask(
      `task-4`,
      async (task) => {
        const response = await fetch("https://jsonplaceholder.typicode.com/comments");

        return await response.json();
      },
      { name: `Task 4` }
    );

    const response = await io.runTask(
      `task-5`,
      async (task) => {
        const response = await fetch("https://jsonplaceholder.typicode.com/photos");

        return await response.json();
      },
      { name: `Task 5` }
    );

    await io.runTask(
      `task-6`,
      async (task) => {
        const response = await fetch("https://jsonplaceholder.typicode.com/users");

        return await response.json();
      },
      { name: `Task 6` }
    );

    return response;
  },
});

client.defineJob({
  id: "long.running",
  name: "Long Running Job",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "long.running",
  }),
  run: async (payload, io, ctx) => {
    // Perform X tasks in an iteration, each one taking X milliseconds
    for (let i = 0; i < payload.iterations; i++) {
      await io.runTask(
        `task.${i}`,
        async (task) => {
          await new Promise((resolve) => setTimeout(resolve, payload.duration ?? 5000));

          return { i };
        },
        { name: `Task ${i}` }
      );
    }
  },
});

client.defineJob({
  id: "stress.logs-of-logs",
  name: "Lots of Logs",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "lots.of.logs",
  }),
  run: async (payload, io, ctx) => {
    // Do lots of logs
    for (let i = 0; i < payload.iterations; i++) {
      await io.logger.info(`before-yield: Iteration ${i} started`);
    }

    // Each are 300KB
    for (let i = 0; i < payload.iterations; i++) {
      await io.runTask(
        `before.yield.${i}`,
        async (task) => {
          return {
            i,
            extra: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n".repeat(
              (300 * payload.size) / 60
            ),
          };
        },
        { name: `before-yield: Task ${i}` }
      );
    }

    io.yield("yield 1");

    // Do lots of logs
    for (let i = 0; i < payload.iterations; i++) {
      await io.logger.info(`after-yield: Iteration ${i} started`);
    }

    for (let i = 0; i < payload.iterations; i++) {
      await io.runTask(
        `after-yield.task.${i}`,
        async (task) => {
          return {
            i,
            extra: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n".repeat(
              (300 * payload.size) / 60
            ),
          };
        },
        { name: `after-yield: Task ${i}` }
      );
    }

    await io.wait("wait-1", 10);

    await io.runTask(
      `after-wait.task`,
      async (task) => {
        return { i: 0 };
      },
      { name: `after-wait: Task 0` }
    );
  },
});

createExpressServer(client);
