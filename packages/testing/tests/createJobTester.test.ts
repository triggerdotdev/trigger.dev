import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { Stripe } from "@trigger.dev/stripe";
import { toHaveSucceeded, createJobTester } from "../src";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

expect.extend({ toHaveSucceeded });
const testJob = createJobTester(vi);

const stripe = new Stripe({
  id: "some-id",
  apiKey: "some-key",
});

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
  expect(testRun.tasks["create-charge"]).toHaveBeenCalledOnce();

  // wask was called with correct params
  expect(testRun.tasks["create-charge"]).toHaveBeenCalledWith({
    amount: 100,
    currency: "usd",
    customer: "cus_123",
    source: "src_123",
  });

  // mocked task output was correctly returned
  expect(testRun.tasks["create-charge"]).toHaveReturnedWith({
    id: "charge_1234",
  });

  // job run has expected output
  expect(testRun.output).toEqual({ id: "charge_1234" });
});

describe("isolation test", () => {
  const jobToTest = client.defineJob({
    id: "isolation-test",
    name: "isolation-test",
    version: "0.1.0",
    trigger: eventTrigger({
      name: "isolation-test",
    }),
    run: async (payload, io, ctx) => {
      const number = await io.runTask("get-number", async () => {
        return 42;
      });
      return { number };
    },
  });

  test("run 1", async () => {
    const testRun = await testJob(jobToTest, {
      tasks: {
        "get-number": 1,
      },
      payload: 1
    });

    // job run was successful
    expect(testRun).toHaveSucceeded();

    // job run has expected output
    expect(testRun.output.number).toEqual(1);
  });

  test("run 2", async () => {
    const testRun = await testJob(jobToTest, {
      tasks: {
        "get-number": 2,
      },
    });

    // job run was successful
    expect(testRun).toHaveSucceeded();

    // job run has expected output
    expect(testRun.output.number).toEqual(2);
  });
});
