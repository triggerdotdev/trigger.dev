import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { Stripe } from "@trigger.dev/stripe";
import { toHaveSucceeded, createJobTester } from "@trigger.dev/testing";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { Dummy } from "../dummy-integration";

expect.extend({ toHaveSucceeded });
const testJob = createJobTester(vi);

const stripe = new Stripe({
  id: "some-id",
  apiKey: "some-key",
});

const dummy = new Dummy({ id: "dummy-integration" });

const client = new TriggerClient({
  id: "testing-endpoint",
  apiKey: "tr_dev_secret",
  apiUrl: "https://localhost",
});

test("no integrations", async () => {
  const jobToTest = client.defineJob({
    id: "no-integrations",
    name: "No Integrations",
    version: "0.1.0",
    trigger: eventTrigger({
      name: "no.integrations",
    }),
    run: async (payload, io, ctx) => {
      return "job done";
    },
  });

  const testRun = await testJob(jobToTest);

  expect(testRun).toHaveSucceeded();

  expect(testRun.output).toEqual("job done");
});

test("stripe integration", async () => {
  const jobToTest = client.defineJob({
    id: "stripe-example-1",
    name: "Stripe Example 1",
    version: "0.1.0",
    trigger: eventTrigger({
      name: "stripe.example",
      schema: z.object({
        customerId: z.string(),
        source: z.string(),
      }),
    }),
    integrations: {
      stripe,
    },
    run: async (payload, io, ctx) => {
      return await io.stripe.createCharge("create-charge", {
        amount: 100,
        currency: "usd",
        source: payload.source,
        customer: payload.customerId,
      });
    },
  });

  const testRun = await testJob(jobToTest, {
    payload: {
      customerId: "cus_123",
      source: "src_123",
    },
    // mock task return
    tasks: {
      "create-charge": {
        id: "charge_1234",
      },
    },
  });

  // job run was successful
  expect(testRun).toHaveSucceeded();

  // task was called exactly once
  expect(testRun.io.stripe.createCharge).toHaveBeenCalledOnce();

  // wask was called with correct params
  expect(testRun.io.stripe.createCharge).toHaveBeenCalledWith("create-charge", {
    amount: 100,
    currency: "usd",
    customer: "cus_123",
    source: "src_123",
  });

  // mocked task output was correctly returned
  expect(testRun.io.stripe.createCharge).toHaveReturnedWith({
    id: "charge_1234",
  });

  // job run has expected output
  expect(testRun.output).toEqual({ id: "charge_1234" });
});

test("dummy integration", async () => {
  const jobToTest = client.defineJob({
    id: "dummy-job",
    name: "Dummy Job",
    version: "0.1.0",
    trigger: eventTrigger({
      name: "start.rolling",
      schema: z.object({
        strangers: z.boolean(),
        rules: z.boolean(),
        thinkingOf: z.string().startsWith("git"),
        never: z.array(z.string()).length(2),
        alsoNever: z.array(z.string())
      }),
    }),
    integrations: {
      dummy,
    },
    run: async (payload, io, ctx) => {
      const getCommitment = (query: string) => (query.endsWith("-a") ? "full" : "partial");
      await io.dummy.taskOne("verse", {
        we: {
          strangersToLove: payload.strangers,
          knowTheRules: payload.rules,
        },
        thinkingOf: `${getCommitment(payload.thinkingOf)} commitment`,
      });
      await io.dummy.taskTwo("chorus", {
        neverGonna: payload.never,
      });
      return ["makeCry", "sayGoodbye"].concat(payload.alsoNever).reduce(
        (rick, never) => ({ ...rick, [never]: false }),
        {}
      );
    },
  });

  const testRun = await testJob(jobToTest, {
    payload: {
      strangers: false,
      rules: true,
      thinkingOf: "git commit -a",
      never: ["give you up", "let you down"],
      alsoNever: ["tellLie", "hurtYou"]
    },
    // mock task return
    tasks: {
      verse: {
        tellYou: {
          how: "I'm feeling",
        },
        makeYou: "understand",
      },
      chorus: {
        alsoNever: ["run around", "desert you"],
      },
    },
  });

  // job run was successful
  expect(testRun).toHaveSucceeded();

  // each task was called exactly once
  expect(testRun.io.dummy.taskOne).toHaveBeenCalledOnce();
  expect(testRun.io.dummy.taskTwo).toHaveBeenCalledOnce();

  // tasks were called with correct params
  expect(testRun.io.dummy.taskOne).toHaveBeenCalledWith("verse", {
    we: {
      strangersToLove: false,
      knowTheRules: true,
    },
    thinkingOf: "full commitment",
  });
  expect(testRun.io.dummy.taskTwo).toHaveBeenCalledWith("chorus", {
    neverGonna: ["give you up", "let you down"],
  });

  // mocked task outputs were correctly returned
  expect(testRun.io.dummy.taskOne).toHaveReturnedWith({
    tellYou: {
      how: "I'm feeling",
    },
    makeYou: "understand",
  });
  expect(testRun.io.dummy.taskTwo).toHaveReturnedWith({
    alsoNever: ["run around", "desert you"],
  });

  // job run has expected output
  expect(testRun.output).toEqual({
    makeCry: false,
    sayGoodbye: false,
    tellLie: false,
    hurtYou: false,
  });
});

test("two integrations", async () => {
  const jobToTest = client.defineJob({
    id: "two-integrations",
    name: "Two Integrations",
    version: "0.1.0",
    trigger: eventTrigger({
      name: "two.integrations",
      schema: z.object({
        customerId: z.string(),
        source: z.string(),
      }),
    }),
    integrations: {
      dummy,
      stripe,
    },
    run: async (payload, io, ctx) => {
      await io.dummy.taskOne("task-one", {
        foo: "bar",
      });
      await io.dummy.taskTwo("task-two", {
        bar: "baz",
      });
      return await io.stripe.createCharge("create-charge", {
        amount: 100,
        currency: "usd",
        source: payload.source,
        customer: payload.customerId,
      });
    },
  });

  const testRun = await testJob(jobToTest, {
    payload: {
      customerId: "cus_123",
      source: "src_123",
    },
    // mock task return
    tasks: {
      "task-one": {
        bar: "baz",
      },
      "task-two": {
        foo: "bar",
      },
      "create-charge": {
        id: "charge_1234",
      },
    },
  });

  // job run was successful
  expect(testRun).toHaveSucceeded();

  // each task was called exactly once
  expect(testRun.io.dummy.taskOne).toHaveBeenCalledOnce();
  expect(testRun.io.dummy.taskTwo).toHaveBeenCalledOnce();
  expect(testRun.io.stripe.createCharge).toHaveBeenCalledOnce();

  // tasks were called with correct params
  expect(testRun.io.dummy.taskOne).toHaveBeenCalledWith("task-one", {
    foo: "bar",
  });
  expect(testRun.io.dummy.taskTwo).toHaveBeenCalledWith("task-two", {
    bar: "baz",
  });
  expect(testRun.io.stripe.createCharge).toHaveBeenCalledWith("create-charge", {
    amount: 100,
    currency: "usd",
    customer: "cus_123",
    source: "src_123",
  });

  // mocked task outputs were correctly returned
  expect(testRun.io.dummy.taskOne).toHaveReturnedWith({ bar: "baz" });
  expect(testRun.io.dummy.taskTwo).toHaveReturnedWith({ foo: "bar" });
  expect(testRun.io.stripe.createCharge).toHaveReturnedWith({
    id: "charge_1234",
  });

  // job run has expected output
  expect(testRun.output).toEqual({ id: "charge_1234" });
});
