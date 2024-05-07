import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger, invokeTrigger, redactString } from "@trigger.dev/sdk";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

client.defineJob({
  id: "random-example",
  name: "Random Example",
  version: "1.0.0",
  enabled: true,
  trigger: eventTrigger({
    name: "random.example",
  }),
  run: async (payload, io, ctx) => {
    // just like Math.random() but wrapped in a Task
    await io.random("random-native");

    // set lower and upper bounds - defaults to 0, 1 respectively
    await io.random("random-min-max", { min: 10, max: 20 });

    // set lower bound only (inclusive)
    await io.random("random-min", { min: 0.5 });

    // set upper bound only (exclusive)
    await io.random("random-max", { max: 100 });

    // round to the nearest integer
    await io.random("random-round", { min: 100, max: 1000, round: true });

    // rounding with floating-point bounds results in a warning
    // this example will unexpectedly (but correctly!) output 1 or 2, skewing towards 2
    await io.random("random-round-float", { min: 0.9, max: 2.5, round: true });

    // negative values work just fine
    await io.random("random-negative", { min: -100, max: -50 });

    // identical lower and upper bounds result in a warning
    await io.random("random-warn-bounds", { min: 10, max: 10 });

    // invalid ranges will fail
    await io.random("random-error", { min: 10, max: 5 });
  },
});

client.defineJob({
  id: "delays-example-1",
  name: "Delays Example 1",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "delays.example",
  }),
  run: async (payload, io, ctx) => {
    await io.wait("wait-1", 60);
  },
});

client.defineJob({
  id: "delays-example-2",
  name: "Delays Example 2 - Long Delay",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "delays.example.long",
  }),
  run: async (payload, io, ctx) => {
    await io.wait("wait-1", 60 * 30);
  },
});

client.defineJob({
  id: "wait-for-request-example",
  name: "Wait for Request Example",
  version: "1.0.0",
  trigger: invokeTrigger(),
  run: async (payload, io, ctx) => {
    const result = await io.waitForRequest<{ message: string }>(
      "wait-for-request",
      async (url) => {
        console.log("Waiting for request", url);
      },
      {
        timeoutInSeconds: 60,
      }
    );

    const result2 = await io.waitForRequest(
      "wait-for-request-2",
      async (url) => {
        console.log("Waiting for request 2", url);
      },
      {
        timeoutInSeconds: 10,
      }
    );
  },
});

client.defineJob({
  id: "screenshot-one-example",
  name: "Screenshot One Example",
  version: "1.0.0",
  trigger: invokeTrigger({
    schema: z.object({
      url: z.string().url().default("https://trigger.dev"),
    }),
  }),
  run: async (payload, io, ctx) => {
    const result = await io.waitForRequest(
      "screenshot-one",
      async (url) => {
        await fetch(`https://api.screenshotone.com/take`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            access_key: process.env["SCREENSHOT_ONE_API_KEY"]!,
            url: payload.url,
            store: "true",
            storage_path: "my-screeshots",
            response_type: "json",
            async: "true",
            webhook_url: url, // this is the URL that will be called when the screenshot is ready
            storage_return_location: "true",
          }),
        });
      },
      {
        timeoutInSeconds: 300,
      }
    );
  },
});

const pollingRunJob = client.defineJob({
  id: "polling-run",
  name: "Background Poll Run",
  version: "1.0.0",
  trigger: invokeTrigger(),
  run: async (payload, io, ctx) => {
    await io.wait("wait", 30);

    return {
      foo: "bar",
    };
  },
});

client.defineJob({
  id: "background-poll",
  name: "Background Poll Example",
  version: "1.0.0",
  trigger: invokeTrigger(),
  run: async (payload, io, ctx) => {
    const run = await pollingRunJob.invoke("invoke");
    // TODO invoke a run and then use the run ID to poll for the result
    const result = await io.backgroundPoll<{ message: string }>("poll", {
      url: `http://localhost:3030/api/v1/runs/${run.id}`,
      requestInit: {
        headers: {
          Accept: "application/json",
          Authorization: redactString`Bearer ${process.env["TRIGGER_API_KEY"]!}`,
        },
      },
      interval: 10,
      timeout: 300,
      responseFilter: {
        status: [200],
        body: {
          status: ["SUCCESS"],
        },
      },
    });
  },
});

const sendWaitForEventJob = client.defineJob({
  id: "send-wait-for-event",
  name: "Send Wait for Event Example",
  version: "1.0.0",
  trigger: invokeTrigger(),
  run: async (payload, io, ctx) => {
    await io.wait("wait", 1);

    await io.sendEvent("send-event", {
      name: "wait.for.event",
      payload: {
        jobId: "wait-for-event",
        foo: "bar",
        ts: new Date(),
      },
      context: ctx,
    });

    await io.sendEvent("send-event-1", {
      name: "wait.for.event",
      payload,
      context: ctx,
    });
  },
});

client.defineJob({
  id: "send-event-example",
  name: "Send Event Example",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "send.event",
  }),
  run: async (payload, io, ctx) => {
    await io.sendEvent("send-event", {
      name: "test.event",
    });
  },
});

client.defineJob({
  id: "wait-for-event",
  name: "Wait for Event Example",
  version: "1.0.0",
  trigger: invokeTrigger(),
  run: async (payload, io, ctx) => {
    await sendWaitForEventJob.invoke("invoke", {
      jobId: "send-wait-for-event",
      foo: "bar",
      ts: new Date(),
    });

    const event = await io.waitForEvent(
      "wait",
      {
        name: "wait.for.event",
        schema: z.object({
          jobId: z.string(),
          foo: z.string(),
          ts: z.coerce.date(),
        }),
        filter: {
          jobId: ["send-wait-for-event"], // only wait for events from this job
        },
      },
      {
        timeoutInSeconds: 60,
      }
    );

    await io.logger.info("Event received", {
      event,
      tsType: typeof event.payload.ts,
      timestampType: typeof event.timestamp,
    });
  },
});

client.defineJob({
  id: "send-events-example",
  name: "Send Multiple Events Example",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "send.events",
  }),
  run: async (payload, io, ctx) => {
    await io.sendEvents(
      "send-events",
      [
        {
          name: "test.event",
          payload: {
            count: 1,
          },
        },
        {
          name: "test.event",
          payload: {
            count: 2,
          },
        },
      ],
      {
        deliverAfter: 10,
      }
    );
  },
});

client.defineJob({
  id: "receive-test-events",
  name: "Receive Test Events",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "test.event",
  }),
  run: async (payload, io, ctx) => {},
});

client.defineJob({
  id: "store-example",
  name: "Key-Value Store Example",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "store.example",
  }),
  run: async (payload, io, ctx) => {
    // key tests
    await io.store.job.set("set-emoji", "🍔", "🐮");
    await io.store.job.get("get-emoji", "🍔");

    await io.store.job.set("set-url", "https://example.com/?foo=bar", "url");
    await io.store.job.get("get-url", "https://example.com/?foo=bar");

    // value tests
    await io.store.job.set("set-undefined", "test", undefined);
    await io.store.job.get("get-undefined", "test");

    await io.store.job.set("set-null", "test", null);
    await io.store.job.get("get-null", "test");

    await io.store.job.set("set-false", "test", false);
    await io.store.job.get("get-false", "test");

    await io.store.job.set("set-zero", "test", 0);
    await io.store.job.get("get-zero", "test");

    await io.store.job.set("set-object", "test", { foo: "bar" });
    await io.store.job.get("get-object", "test");

    await io.store.job.delete("delete-value-test", "test");

    // job store
    await io.store.job.get("job-get-nonexistent", "some-key");
    await io.store.job.has("job-has-nonexistent", "some-key");
    await io.store.job.set("job-set", "some-key", "some-value");
    await io.store.job.has("job-has", "some-key");
    await io.store.job.get("job-get", "some-key");
    await io.store.job.delete("job-delete", "some-key");
    await io.store.job.delete("job-delete-nonexistent", "some-key");

    // run store
    await io.store.run.get("run-get-nonexistent", "some-key");
    await io.store.run.has("run-has-nonexistent", "some-key");
    await io.store.run.set("run-set", "some-key", "some-value");
    await io.store.run.has("run-has", "some-key");
    await io.store.run.get("run-get", "some-key");
    await io.store.run.delete("run-delete", "some-key");
    await io.store.run.delete("run-delete-nonexistent", "some-key");

    // env store
    await io.store.env.get("env-get-nonexistent", "some-key");
    await io.store.env.has("env-has-nonexistent", "some-key");
    await io.store.env.set("env-set", "some-key", "some-value");
    await io.store.env.has("env-has", "some-key");
    await io.store.env.get("env-get", "some-key");
    await io.store.env.delete("env-delete", "some-key");
    await io.store.env.delete("env-delete-nonexistent", "some-key");

    // fail on large value
    const largeValue = Array(256 * 1024)
      .fill("F")
      .join("");

    await io.store.job.set("large-value-fail", "large-value", largeValue);
    await io.store.job.delete("large-value-delete", "large-value");
  },
});

createExpressServer(client);
