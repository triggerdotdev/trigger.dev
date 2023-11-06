import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger, invokeTrigger } from "@trigger.dev/sdk";

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

createExpressServer(client);
