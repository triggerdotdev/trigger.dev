import {
  taskContext,
  WebhookEndpointNotFoundError,
  WebhookFilterError,
  WebhookWaiterLimitError,
} from "@trigger.dev/core/v3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure } from "../src/v3/auth.js";
import { idempotencyKeys } from "../src/v3/idempotencyKeys.js";
import { webhooks } from "../src/v3/webhooks.js";

const payments = webhooks.endpoint.define({ id: "waiter-errors", source: webhooks.stripe() });

function respondWith(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })
    )
  );
}

async function createError() {
  try {
    await webhooks.waiter.create(
      payments,
      { match: { "event.type": "x" } },
      { retry: { maxAttempts: 1 } }
    );
  } catch (error) {
    return error;
  }
  throw new Error("expected create to throw");
}

describe("webhooks.waiter.create errors", () => {
  beforeEach(() => configure({ baseURL: "http://localhost:3030", accessToken: "tr_dev_test" }));
  afterEach(() => vi.unstubAllGlobals());

  it("maps the server's error codes to typed errors", async () => {
    respondWith(422, {
      error: "the timeout is longer than the 90 day maximum",
      code: "webhook_waiter_limit",
      reason: "timeout_too_long",
    });
    const limit = await createError();
    expect(limit).toBeInstanceOf(WebhookWaiterLimitError);
    expect((limit as WebhookWaiterLimitError).reason).toBe("timeout_too_long");
    expect((limit as Error).message).toBe("the timeout is longer than the 90 day maximum");

    respondWith(422, { error: "expected a value", code: "webhook_filter_invalid" });
    expect(await createError()).toBeInstanceOf(WebhookFilterError);

    respondWith(404, { error: "No active webhook endpoint", code: "webhook_endpoint_not_found" });
    expect(await createError()).toBeInstanceOf(WebhookEndpointNotFoundError);
  });

  it("passes other API errors through unchanged", async () => {
    respondWith(400, { error: "bad" });
    const error = await createError();
    expect((error as Error).name).toBe("TriggerApiError");
    expect((error as Error).message).toBe("bad");
  });
});

describe("webhooks.waiter.create idempotency keys", () => {
  const sent: string[] = [];

  beforeEach(() => {
    sent.length = 0;
    configure({ baseURL: "http://localhost:3030", accessToken: "tr_dev_test" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)).idempotencyKey);
        return new Response(
          JSON.stringify({
            id: "waitpoint_1",
            expiresAt: new Date().toISOString(),
            isCached: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    taskContext.disable();
  });

  function inRun(runId: string, attempt: number) {
    taskContext.setGlobalTaskContext({
      ctx: { run: { id: runId }, attempt: { number: attempt } },
    } as never);
  }

  const create = (idempotencyKey?: string) =>
    webhooks.waiter.create(payments, { match: { "event.type": "x" }, idempotencyKey });

  it("scopes a string key to the run, so a retry finds the same waiter", async () => {
    inRun("run_a", 1);
    await create("payment");
    inRun("run_a", 2);
    await create("payment");
    inRun("run_b", 1);
    await create("payment");

    expect(sent[0]).toBe(sent[1]);
    expect(sent[2]).not.toBe(sent[0]);
    expect(sent[0]).not.toBe("payment");
  });

  it("keeps the scope of a key from idempotencyKeys.create", async () => {
    inRun("run_a", 1);
    await create(await idempotencyKeys.create("payment", { scope: "attempt" }));
    inRun("run_a", 2);
    await create(await idempotencyKeys.create("payment", { scope: "attempt" }));
    await create(await idempotencyKeys.create("payment", { scope: "global" }));
    inRun("run_b", 1);
    await create(await idempotencyKeys.create("payment", { scope: "global" }));

    expect(sent[0]).not.toBe(sent[1]);
    expect(sent[2]).toBe(sent[3]);
  });

  it("makes a new waiter per call without a key", async () => {
    inRun("run_a", 1);
    await create();
    await create();
    expect(sent[0]).not.toBe(sent[1]);
  });
});
