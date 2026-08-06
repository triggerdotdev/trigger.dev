import { apiClientManager } from "@trigger.dev/core/v3";
import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { batch } from "./batch.js";
import { createTask } from "./shared.js";
import { tasks } from "./tasks.js";

const debounceFor = (i: number) => ({
  key: `warm-conn-notify:${i}`,
  delay: "12h",
  maxDelay: "24h",
  mode: "trailing" as const,
});

const EXPECTED = [debounceFor(0), debounceFor(1)];

type Payload = { i: number };

const taskA = createTask({
  id: "task-a",
  run: async (_payload: Payload) => ({ ok: true }),
});

const taskB = createTask({
  id: "task-b",
  run: async (_payload: Payload) => ({ ok: true }),
});

type SentItem = {
  index: number;
  task: string;
  options?: { debounce?: { key: string; delay: string; mode?: string; maxDelay?: string } };
};

/**
 * Captures the NDJSON item stream the SDK sends in phase 2 of a batch trigger,
 * answering the only question these tests care about: what actually reached the
 * wire. Phase 1 (create) and the item stream get canned success responses.
 */
function installBatchCapture() {
  const sent: SentItem[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));

    if (url.endsWith("/api/v3/batches")) {
      const body = JSON.parse(String(init?.body));
      return Response.json({ id: "batch_test", runCount: body.runCount, isCached: false });
    }

    if (url.includes("/api/v3/batches/") && url.endsWith("/items")) {
      const ndjson = await new Response(init?.body as any).text();
      const lines = ndjson.split("\n").filter((line) => line.trim().length > 0);
      sent.push(...lines.map((line) => JSON.parse(line) as SentItem));

      return Response.json({
        id: "batch_test",
        itemsAccepted: lines.length,
        itemsDeduplicated: 0,
        sealed: true,
      });
    }

    throw new Error(`Unexpected request during batch trigger: ${url}`);
  }) as typeof fetch;

  return {
    debounceOptions: () =>
      [...sent].sort((a, b) => a.index - b.index).map((item) => item.options?.debounce),
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function* asAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

describe("batch trigger debounce forwarding", () => {
  let capture: ReturnType<typeof installBatchCapture>;

  beforeEach(() => {
    apiClientManager.setGlobalAPIClientConfiguration({
      baseURL: "http://localhost:3030",
      accessToken: "tr_dev_test",
    });
    capture = installBatchCapture();
  });

  afterEach(() => {
    capture.restore();
    apiClientManager.disable();
  });

  const surfaces: Array<{ name: string; call: () => Promise<unknown> }> = [
    {
      name: "task.batchTrigger(array)",
      call: () =>
        taskA.batchTrigger([
          { payload: { i: 0 }, options: { debounce: debounceFor(0) } },
          { payload: { i: 1 }, options: { debounce: debounceFor(1) } },
        ]),
    },
    {
      name: "task.batchTrigger(asyncIterable)",
      call: () =>
        taskA.batchTrigger(
          asAsyncIterable([
            { payload: { i: 0 }, options: { debounce: debounceFor(0) } },
            { payload: { i: 1 }, options: { debounce: debounceFor(1) } },
          ])
        ),
    },
    {
      name: "tasks.batchTrigger(array)",
      call: () =>
        tasks.batchTrigger<typeof taskA>("task-a", [
          { payload: { i: 0 }, options: { debounce: debounceFor(0) } },
          { payload: { i: 1 }, options: { debounce: debounceFor(1) } },
        ]),
    },
    {
      name: "batch.trigger(array)",
      call: () =>
        batch.trigger<typeof taskA | typeof taskB>([
          { id: "task-a", payload: { i: 0 }, options: { debounce: debounceFor(0) } },
          { id: "task-b", payload: { i: 1 }, options: { debounce: debounceFor(1) } },
        ]),
    },
    {
      name: "batch.trigger(asyncIterable)",
      call: () =>
        batch.trigger<typeof taskA | typeof taskB>(
          asAsyncIterable([
            { id: "task-a" as const, payload: { i: 0 }, options: { debounce: debounceFor(0) } },
            { id: "task-b" as const, payload: { i: 1 }, options: { debounce: debounceFor(1) } },
          ])
        ),
    },
    {
      name: "batch.triggerByTask(array)",
      call: () =>
        batch.triggerByTask([
          { task: taskA, payload: { i: 0 }, options: { debounce: debounceFor(0) } },
          { task: taskB, payload: { i: 1 }, options: { debounce: debounceFor(1) } },
        ]),
    },
    {
      name: "batch.triggerByTask(asyncIterable)",
      call: () =>
        batch.triggerByTask(
          asAsyncIterable([
            { task: taskA, payload: { i: 0 }, options: { debounce: debounceFor(0) } },
            { task: taskB, payload: { i: 1 }, options: { debounce: debounceFor(1) } },
          ])
        ),
    },
  ];

  it.each(surfaces)("$name forwards debounce for every item", async ({ call }) => {
    await call();

    expect(capture.debounceOptions()).toEqual(EXPECTED);
  });

  const waitSurfaces: Array<{ name: string; call: () => Promise<unknown> }> = [
    {
      name: "task.batchTriggerAndWait(array)",
      call: () =>
        taskA.batchTriggerAndWait([
          { payload: { i: 0 }, options: { debounce: debounceFor(0) } },
          { payload: { i: 1 }, options: { debounce: debounceFor(1) } },
        ]),
    },
    {
      name: "task.batchTriggerAndWait(asyncIterable)",
      call: () =>
        taskA.batchTriggerAndWait(
          asAsyncIterable([
            { payload: { i: 0 }, options: { debounce: debounceFor(0) } },
            { payload: { i: 1 }, options: { debounce: debounceFor(1) } },
          ])
        ),
    },
    {
      name: "tasks.batchTriggerAndWait(array)",
      call: () =>
        tasks.batchTriggerAndWait<typeof taskA>("task-a", [
          { payload: { i: 0 }, options: { debounce: debounceFor(0) } },
          { payload: { i: 1 }, options: { debounce: debounceFor(1) } },
        ]),
    },
    {
      name: "batch.triggerAndWait(array)",
      call: () =>
        batch.triggerAndWait<typeof taskA | typeof taskB>([
          { id: "task-a", payload: { i: 0 }, options: { debounce: debounceFor(0) } },
          { id: "task-b", payload: { i: 1 }, options: { debounce: debounceFor(1) } },
        ]),
    },
    {
      name: "batch.triggerAndWait(asyncIterable)",
      call: () =>
        batch.triggerAndWait<typeof taskA | typeof taskB>(
          asAsyncIterable([
            { id: "task-a" as const, payload: { i: 0 }, options: { debounce: debounceFor(0) } },
            { id: "task-b" as const, payload: { i: 1 }, options: { debounce: debounceFor(1) } },
          ])
        ),
    },
    {
      name: "batch.triggerByTaskAndWait(array)",
      call: () =>
        batch.triggerByTaskAndWait([
          { task: taskA, payload: { i: 0 }, options: { debounce: debounceFor(0) } },
          { task: taskB, payload: { i: 1 }, options: { debounce: debounceFor(1) } },
        ]),
    },
    {
      name: "batch.triggerByTaskAndWait(asyncIterable)",
      call: () =>
        batch.triggerByTaskAndWait(
          asAsyncIterable([
            { task: taskA, payload: { i: 0 }, options: { debounce: debounceFor(0) } },
            { task: taskB, payload: { i: 1 }, options: { debounce: debounceFor(1) } },
          ])
        ),
    },
  ];

  it.each(waitSurfaces)("$name forwards debounce for every item", async ({ call }) => {
    await runInMockTaskContext(async () => {
      await call();
    });

    expect(capture.debounceOptions()).toEqual(EXPECTED);
  });
});
