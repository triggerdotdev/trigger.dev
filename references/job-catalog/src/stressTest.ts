import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { readFile } from "node:fs/promises";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: true,
  ioLogLocalEnabled: false,
});

client.defineJob({
  id: "stress-test-1",
  name: "Stress Test 1",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "stress.test.1",
  }),
  run: async (payload, io, ctx) => {},
});

client.defineJob({
  id: "stress-test-errored-task",
  name: "Stress Test Errored Task",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "stress.test.error-task",
  }),
  run: async (payload, io, ctx) => {
    await io.runTask(
      `task-1`,
      async (task) => {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return { success: true };
      },
      { name: `Task 1` }
    );

    await io.wait("wait-1", 1);

    await io.runTask(
      `task-2`,
      async (task) => {
        return { fixed: "task" };
      },
      { name: `Task 1` }
    );
  },
});

client.defineJob({
  id: "stress-test-disabled",
  name: "Stress Test Disabled",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "stress.test.disabled",
  }),
  enabled: false,
  run: async (payload, io, ctx) => {
    await io.wait("wait-1", 20);

    await io.runTask(
      `task-1`,
      async (task) => {
        await new Promise((resolve) => setTimeout(resolve, 10000));
      },
      { name: `Task 1` }
    );

    await io.wait("wait-2", 5);
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
  id: "stress-test-event-loop-lag",
  name: "Stress Test Event Loop Lag",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "stress.test.event.loop.lag",
  }),
  run: async (payload, io, ctx) => {
    const photos = await io.runTask(
      `task-1`,
      async (task) => {
        const file = await readFile("./fixtures/large.json");

        return JSON.parse(file.toString());
      },
      { name: `Task 1` }
    );

    await io.runTask(`task-2`, async (task) => {}, { name: `Task 2`, params: { photos } });

    const morePhotos = await io.runTask(
      `task-3`,
      async (task) => {
        const file = await readFile("./fixtures/toolarge.json");

        return JSON.parse(file.toString());
      },
      { name: `Task 3` }
    );

    await io.runTask(`task-4`, async (task) => {}, { name: `Task 4`, params: { morePhotos } });
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
