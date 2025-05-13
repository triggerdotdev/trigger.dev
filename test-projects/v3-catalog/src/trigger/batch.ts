import { Equal, Expect } from "@/utils/types.js";
import {
  AnyRealtimeRun,
  auth,
  batch,
  idempotencyKeys,
  logger,
  runs,
  task,
  tasks,
  wait,
} from "@trigger.dev/sdk/v3";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

export const batchParentTask = task({
  id: "batch-parent-task",
  run: async (payload: { size?: number; wait?: boolean }) => {
    const items = Array.from({ length: payload.size ?? 10 }, (_, i) => ({
      payload: {
        id: `item${i}`,
        name: `Item Name ${i}`,
        description: `This is a description for item ${i}`,
        value: i,
        timestamp: new Date().toISOString(),
        foo: {
          id: `item${i}`,
          name: `Item Name ${i}`,
          description: `This is a description for item ${i}`,
          value: i,
          timestamp: new Date().toISOString(),
        },
        bar: {
          id: `item${i}`,
          name: `Item Name ${i}`,
          description: `This is a description for item ${i}`,
          value: i,
          timestamp: new Date().toISOString(),
        },
      },
      options: {
        idempotencyKey: `item${i}`,
      },
    }));

    return payload.wait
      ? await batchChildTask.batchTriggerAndWait(items.map((i) => ({ payload: i.payload })))
      : await batchChildTask.batchTrigger(items);
  },
});

export const triggerWithQueue = task({
  id: "trigger-with-queue",
  run: async () => {
    await batchChildTask.trigger(
      {},
      {
        queue: {
          name: "batch-queue-foo",
          concurrencyLimit: 10,
        },
      }
    );
  },
});

export const batchParentWitFailsTask = task({
  id: "batch-parent-with-fails-task",
  retry: {
    maxAttempts: 1,
  },
  run: async () => {
    const response = await taskThatFails.batchTriggerAndWait([
      { payload: false },
      { payload: true },
      { payload: false },
    ]);

    logger.info("Batch response", { response });

    const respone2 = await taskThatFails.batchTriggerAndWait([
      { payload: true },
      { payload: false },
      { payload: true },
    ]);

    logger.info("Batch response2", { respone2 });
  },
});

export const batchChildTask = task({
  id: "batch-child-task",
  retry: {
    maxAttempts: 2,
  },
  run: async (payload: any, { ctx }) => {
    logger.info("Processing child task", { payload });

    await wait.for({ seconds: 1 });

    return `${payload} - processed`;
  },
});

export const taskThatFails = task({
  id: "task-that-fails",
  retry: {
    maxAttempts: 2,
  },
  run: async (fail: boolean) => {
    logger.info(`Will fail ${fail}`);

    if (fail) {
      throw new Error("Task failed");
    }

    return {
      foo: "bar",
    };
  },
});

export const allV2TestTask = task({
  id: "all-v2-test",
  retry: {
    maxAttempts: 1,
  },
  run: async ({ triggerSequentially }: { triggerSequentially?: boolean }, { ctx }) => {
    const response1 = await batch.trigger<typeof allV2ChildTask1 | typeof allV2ChildTask2>(
      [
        {
          id: "all-v2-test-child-1",
          payload: { child1: "foo" },
          options: { idempotencyKey: randomUUID() },
        },
        {
          id: "all-v2-test-child-2",
          payload: { child2: "bar" },
          options: { idempotencyKey: randomUUID() },
        },
        {
          id: "all-v2-test-child-1",
          payload: { child1: "baz" },
          options: { idempotencyKey: randomUUID() },
        },
      ],
      {
        triggerSequentially,
      }
    );

    logger.debug("Response 1", { response1 });

    for (const run of response1.runs) {
      switch (run.taskIdentifier) {
        case "all-v2-test-child-1": {
          const run1 = await runs.retrieve(run);

          type Run1Payload = Expect<Equal<typeof run1.payload, { child1: string } | undefined>>;
          type Run1Output = Expect<Equal<typeof run1.output, { foo: string } | undefined>>;

          break;
        }
        case "all-v2-test-child-2": {
          const run2 = await runs.retrieve(run);

          type Run2Payload = Expect<Equal<typeof run2.payload, { child2: string } | undefined>>;
          type Run2Output = Expect<Equal<typeof run2.output, { bar: string } | undefined>>;

          break;
        }
      }
    }

    const {
      runs: [batchRun1, batchRun2, batchRun3],
    } = await batch.triggerByTask(
      [
        { task: allV2ChildTask1, payload: { child1: "foo" } },
        { task: allV2ChildTask2, payload: { child2: "bar" } },
        { task: allV2ChildTask1, payload: { child1: "baz" } },
      ],
      {
        triggerSequentially,
      }
    );

    logger.debug("Batch runs", { batchRun1, batchRun2, batchRun3 });

    const taskRun1 = await runs.retrieve(batchRun1);

    type TaskRun1Payload = Expect<Equal<typeof taskRun1.payload, { child1: string } | undefined>>;
    type TaskRun1Output = Expect<Equal<typeof taskRun1.output, { foo: string } | undefined>>;

    const taskRun2 = await runs.retrieve(batchRun2);

    type TaskRun2Payload = Expect<Equal<typeof taskRun2.payload, { child2: string } | undefined>>;
    type TaskRun2Output = Expect<Equal<typeof taskRun2.output, { bar: string } | undefined>>;

    const taskRun3 = await runs.retrieve(batchRun3);

    type TaskRun3Payload = Expect<Equal<typeof taskRun3.payload, { child1: string } | undefined>>;
    type TaskRun3Output = Expect<Equal<typeof taskRun3.output, { foo: string } | undefined>>;

    const response3 = await batch.triggerAndWait<typeof allV2ChildTask1 | typeof allV2ChildTask2>(
      [
        { id: "all-v2-test-child-1", payload: { child1: "foo" } },
        { id: "all-v2-test-child-2", payload: { child2: "bar" } },
        { id: "all-v2-test-child-1", payload: { child1: "baz" } },
      ],
      {
        triggerSequentially,
      }
    );

    logger.debug("Response 3", { response3 });

    for (const run of response3.runs) {
      if (run.ok) {
        switch (run.taskIdentifier) {
          case "all-v2-test-child-1": {
            type Run1Output = Expect<Equal<typeof run.output, { foo: string }>>;

            break;
          }
          case "all-v2-test-child-2": {
            type Run2Output = Expect<Equal<typeof run.output, { bar: string }>>;

            break;
          }
        }
      }
    }

    for (const run of response3.runs) {
      switch (run.taskIdentifier) {
        case "all-v2-test-child-1": {
          if (run.ok) {
            type Run1Output = Expect<Equal<typeof run.output, { foo: string }>>;
          }

          break;
        }
        case "all-v2-test-child-2": {
          if (run.ok) {
            type Run2Output = Expect<Equal<typeof run.output, { bar: string }>>;
          }

          break;
        }
      }
    }

    const {
      runs: [batch2Run1, batch2Run2, batch2Run3],
    } = await batch.triggerByTaskAndWait(
      [
        { task: allV2ChildTask1, payload: { child1: "foo" } },
        { task: allV2ChildTask2, payload: { child2: "bar" } },
        { task: allV2ChildTask1, payload: { child1: "baz" } },
      ],
      {
        triggerSequentially,
      }
    );

    logger.debug("Batch 2 runs", { batch2Run1, batch2Run2, batch2Run3 });

    if (batch2Run1.ok) {
      type Batch2Run1Output = Expect<Equal<typeof batch2Run1.output, { foo: string }>>;
    }

    if (batch2Run2.ok) {
      type Batch2Run2Output = Expect<Equal<typeof batch2Run2.output, { bar: string }>>;
    }

    if (batch2Run3.ok) {
      type Batch2Run3Output = Expect<Equal<typeof batch2Run3.output, { foo: string }>>;
    }
  },
});

export const allV2ChildTask1 = task({
  id: "all-v2-test-child-1",
  retry: {
    maxAttempts: 1,
  },
  run: async (payload: { child1: string }) => {
    return {
      foo: "bar",
    };
  },
});

export const allV2ChildTask2 = task({
  id: "all-v2-test-child-2",
  retry: {
    maxAttempts: 1,
  },
  run: async (payload: { child2: string }) => {
    return {
      bar: "baz",
    };
  },
});

export const batchV2TestTask = task({
  id: "batch-v2-test",
  retry: {
    maxAttempts: 1,
  },
  run: async ({
    triggerSequentially,
    largeBatchSize = 20,
  }: {
    triggerSequentially?: boolean;
    largeBatchSize?: number;
  }) => {
    // First lets try triggering with too many items
    try {
      await tasks.batchTrigger<typeof batchV2TestChild>(
        "batch-v2-test-child",
        Array.from({ length: 501 }, (_, i) => ({
          payload: { foo: `bar${i}` },
        })),
        {
          triggerSequentially,
        }
      );

      assert.fail("Batch trigger should have failed");
    } catch (error: any) {
      assert.equal(
        error.message,
        '400 "Batch size of 501 is too large. Maximum allowed batch size is 500."',
        "Batch trigger failed with wrong error"
      );
    }

    // TODO tests:
    // tasks.batchTrigger
    // tasks.batchTriggerAndWait
    // myTask.batchTriggerAndWait
    const response1 = await batchV2TestChild.batchTrigger(
      [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }],
      {
        triggerSequentially,
      }
    );

    logger.info("Response 1", { response1 });

    // Check that the batch ID matches this kind of ID: batch_g5obektq4xv699mq7eb9q
    assert.match(response1.batchId, /^batch_[a-z0-9]{21}$/, "response1: Batch ID is invalid");
    assert.equal(response1.runs.length, 2, "response1: Items length is invalid");
    assert.match(response1.runs[0].id, /^run_[a-z0-9]{21}$/, "response1: Run ID is invalid");
    assert.equal(
      response1.runs[0].taskIdentifier,
      "batch-v2-test-child",
      "response1: runs[0] Task identifier is invalid"
    );
    assert.equal(response1.runs[0].isCached, false, "response1: runs[0] Run is cached");
    assert.equal(
      response1.runs[0].idempotencyKey,
      undefined,
      "response1: runs[0] Idempotent key is invalid"
    );

    assert.match(
      response1.runs[1].id,
      /^run_[a-z0-9]{21}$/,
      "response1: runs[1] Run ID is invalid"
    );
    assert.equal(
      response1.runs[1].taskIdentifier,
      "batch-v2-test-child",
      "response1: runs[1] Task identifier is invalid"
    );
    assert.equal(response1.runs[1].isCached, false, "response1: runs[1] Run is cached");
    assert.equal(
      response1.runs[1].idempotencyKey,
      undefined,
      "response1: runs[1] Idempotent key is invalid"
    );

    await auth.withAuth({ accessToken: response1.publicAccessToken }, async () => {
      const [run0, run1] = await Promise.all([
        runs.retrieve(response1.runs[0].id),
        runs.retrieve(response1.runs[1].id),
      ]);

      logger.debug("retrieved response 1 runs", { run0, run1 });

      for await (const liveRun0 of runs.subscribeToRun(response1.runs[0].id)) {
        logger.debug("subscribed to run0", { liveRun0 });

        if (liveRun0.finishedAt) {
          break;
        }
      }

      for await (const liveRun1 of runs.subscribeToRun(response1.runs[1].id)) {
        logger.debug("subscribed to run1", { liveRun1 });

        if (liveRun1.finishedAt) {
          break;
        }
      }
    });

    // Now let's do another batch trigger, this time with 100 items, and immediately try and retrieve the last run
    const response2 = await batchV2TestChild.batchTrigger(
      Array.from({ length: 30 }, (_, i) => ({
        payload: { foo: `bar${i}` },
      })),
      {
        triggerSequentially,
      }
    );

    logger.info("Response 2", { response2 });

    assert.equal(response2.runs.length, 30, "response2: Items length is invalid");

    const lastRunId = response2.runs[response2.runs.length - 1].id;

    const lastRun = await runs.retrieve(lastRunId);

    logger.info("Last run", { lastRun });

    assert.equal(lastRun.id, lastRunId, "response2: Last run ID is invalid");

    // okay, now we are going to test using the batch-level idempotency key
    // we need to test that when reusing the idempotency key, we retrieve the same batch and runs and the response is correct
    // we will also need to test idempotencyKeyTTL and make sure that the key is not reused after the TTL has expired
    const idempotencyKey1 = randomUUID();

    const response3 = await batchV2TestChild.batchTrigger(
      [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }],
      {
        idempotencyKey: idempotencyKey1,
        idempotencyKeyTTL: "5s",
        triggerSequentially,
      }
    );

    logger.info("Response 3", { response3 });

    assert.equal(response3.isCached, false, "response3: Batch is cached");
    assert.ok(response3.idempotencyKey, "response3: Batch idempotency key is invalid");
    assert.equal(response3.runs.length, 2, "response3: Items length is invalid");
    assert.equal(response3.runs[0].isCached, false, "response3: runs[0] Run is cached");
    assert.equal(response3.runs[1].isCached, false, "response3: runs[1] Run is cached");

    const response4 = await batchV2TestChild.batchTrigger(
      [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }],
      {
        idempotencyKey: idempotencyKey1,
        idempotencyKeyTTL: "5s",
        triggerSequentially,
      }
    );

    logger.info("Response 4", { response4 });

    assert.equal(response4.batchId, response3.batchId, "response4: Batch ID is invalid");
    assert.equal(response4.isCached, true, "response4: Batch is not cached");
    assert.equal(response4.runs.length, 2, "response4: Items length is invalid");
    assert.equal(response4.runs[0].isCached, true, "response4: runs[0] Run is not cached");
    assert.equal(response4.runs[1].isCached, true, "response4: runs[1] Run is not cached");
    assert.equal(
      response4.runs[0].id,
      response3.runs[0].id,
      "response4: runs[0] Run ID is invalid"
    );
    assert.equal(
      response4.runs[1].id,
      response3.runs[1].id,
      "response4: runs[1] Run ID is invalid"
    );

    await wait.for({ seconds: 6 });

    const response5 = await batchV2TestChild.batchTrigger(
      [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }],
      {
        idempotencyKey: idempotencyKey1,
        idempotencyKeyTTL: "5s",
        triggerSequentially,
      }
    );

    logger.info("Response 5", { response5 });

    assert.equal(response5.isCached, false, "response5: Batch is cached");
    assert.notEqual(response5.batchId, response3.batchId, "response5: Batch ID is invalid");
    assert.equal(response5.runs.length, 2, "response5: Items length is invalid");
    assert.equal(response5.runs[0].isCached, false, "response5: runs[0] Run is cached");
    assert.equal(response5.runs[1].isCached, false, "response5: runs[1] Run is cached");

    // Now we need to test with idempotency keys on the individual runs
    // The first test will make sure that the idempotency key is passed to the child task
    const idempotencyKeyChild1 = randomUUID();
    const idempotencyKeyChild2 = randomUUID();

    const response6 = await batchV2TestChild.batchTrigger(
      [
        {
          payload: { foo: "bar" },
          options: { idempotencyKey: idempotencyKeyChild1, idempotencyKeyTTL: "5s" },
        },
        {
          payload: { foo: "baz" },
          options: { idempotencyKey: idempotencyKeyChild2, idempotencyKeyTTL: "15s" },
        },
      ],
      {
        triggerSequentially,
      }
    );

    logger.info("Response 6", { response6 });

    assert.equal(response6.runs.length, 2, "response6: Items length is invalid");
    assert.equal(response6.runs[0].isCached, false, "response6: runs[0] Run is cached");
    assert.equal(response6.runs[1].isCached, false, "response6: runs[1] Run is cached");
    assert.ok(response6.runs[0].idempotencyKey, "response6: runs[0] Idempotent key is invalid");
    assert.ok(response6.runs[1].idempotencyKey, "response6: runs[1] Idempotent key is invalid");

    await setTimeout(1000);

    const response7 = await batchV2TestChild.batchTrigger(
      [
        { payload: { foo: "bar" }, options: { idempotencyKey: idempotencyKeyChild1 } },
        { payload: { foo: "baz" }, options: { idempotencyKey: idempotencyKeyChild2 } },
      ],
      {
        triggerSequentially,
      }
    );

    logger.info("Response 7", { response7 });

    assert.equal(response7.runs.length, 2, "response7: Items length is invalid");
    assert.equal(response7.runs[0].isCached, true, "response7: runs[0] Run is not cached");
    assert.equal(response7.runs[1].isCached, true, "response7: runs[1] Run is not cached");
    assert.equal(
      response7.runs[0].id,
      response6.runs[0].id,
      "response7: runs[0] Run ID is invalid"
    );
    assert.equal(
      response7.runs[1].id,
      response6.runs[1].id,
      "response7: runs[1] Run ID is invalid"
    );

    await wait.for({ seconds: 6 });

    // Now we need to test that the first run is not cached and is a new run, and the second run is cached
    const response8 = await batchV2TestChild.batchTrigger(
      [
        { payload: { foo: "bar" }, options: { idempotencyKey: idempotencyKeyChild1 } },
        { payload: { foo: "baz" }, options: { idempotencyKey: idempotencyKeyChild2 } },
      ],
      {
        triggerSequentially,
      }
    );

    logger.info("Response 8", { response8 });

    assert.equal(response8.runs.length, 2, "response8: Items length is invalid");
    assert.equal(response8.runs[0].isCached, false, "response8: runs[0] Run is cached");
    assert.equal(response8.runs[1].isCached, true, "response8: runs[1] Run is not cached");
    assert.notEqual(
      response8.runs[0].id,
      response6.runs[0].id,
      "response8: runs[0] Run ID is invalid"
    );
    assert.equal(
      response8.runs[1].id,
      response6.runs[1].id,
      "response8: runs[1] Run ID is invalid"
    );

    // Now we need to test with batchTriggerAndWait
    const response9 = await batchV2TestChild.batchTriggerAndWait(
      [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }],
      {
        triggerSequentially,
      }
    );

    logger.debug("Response 9", { response9 });

    assert.match(response9.id, /^batch_[a-z0-9]{21}$/, "response9: Batch ID is invalid");
    assert.equal(response9.runs.length, 2, "response9: Items length is invalid");
    assert.ok(response9.runs[0].ok, "response9: runs[0] is not ok");
    assert.ok(response9.runs[1].ok, "response9: runs[1] is not ok");
    assert.equal(
      response9.runs[0].taskIdentifier,
      "batch-v2-test-child",
      "response9: runs[0] Task identifier is invalid"
    );
    assert.equal(
      response9.runs[1].taskIdentifier,
      "batch-v2-test-child",
      "response9: runs[1] Task identifier is invalid"
    );
    assert.deepEqual(
      response9.runs[0].output,
      { foo: "bar" },
      "response9: runs[0] result is invalid"
    );
    assert.deepEqual(
      response9.runs[1].output,
      { foo: "baz" },
      "response9: runs[1] result is invalid"
    );

    // Now batchTriggerAndWait with 21 items
    const response10 = await batchV2TestChild.batchTriggerAndWait(
      Array.from({ length: largeBatchSize }, (_, i) => ({
        payload: { foo: `bar${i}` },
      })),
      {
        triggerSequentially,
      }
    );

    logger.debug("Response 10", { response10 });

    assert.match(response10.id, /^batch_[a-z0-9]{21}$/, "response10: Batch ID is invalid");
    assert.equal(response10.runs.length, largeBatchSize, "response10: Items length is invalid");

    // Now repeat the first few tests using `tasks.batchTrigger`:
    const response11 = await tasks.batchTrigger<typeof batchV2TestChild>(
      "batch-v2-test-child",
      [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }],
      {
        triggerSequentially,
      }
    );

    logger.debug("Response 11", { response11 });

    assert.match(response11.batchId, /^batch_[a-z0-9]{21}$/, "response11: Batch ID is invalid");
    assert.equal(response11.runs.length, 2, "response11: Items length is invalid");
    assert.match(response11.runs[0].id, /^run_[a-z0-9]{21}$/, "response11: Run ID is invalid");
    assert.equal(
      response11.runs[0].taskIdentifier,
      "batch-v2-test-child",
      "response11: runs[0] Task identifier is invalid"
    );
    assert.equal(response11.runs[0].isCached, false, "response11: runs[0] Run is cached");
    assert.equal(
      response11.runs[0].idempotencyKey,
      undefined,
      "response11: runs[0] Idempotent key is invalid"
    );

    // Now use tasks.batchTrigger with 100 items
    const response12 = await tasks.batchTrigger<typeof batchV2TestChild>(
      "batch-v2-test-child",
      Array.from({ length: 100 }, (_, i) => ({
        payload: { foo: `bar${i}` },
      })),
      {
        triggerSequentially,
      }
    );

    const response12Start = performance.now();

    logger.debug("Response 12", { response12 });

    assert.match(response12.batchId, /^batch_[a-z0-9]{21}$/, "response12: Batch ID is invalid");
    assert.equal(response12.runs.length, 100, "response12: Items length is invalid");

    const runsById: Map<string, AnyRealtimeRun> = new Map();

    for await (const run of runs.subscribeToBatch(response12.batchId)) {
      runsById.set(run.id, run);

      // Break if we have received all runs
      if (runsById.size === response12.runs.length) {
        break;
      }
    }

    const response12End = performance.now();

    logger.debug("Response 12 time", { time: response12End - response12Start });

    logger.debug("All runs", { runsById: Object.fromEntries(runsById) });

    assert.equal(runsById.size, 100, "All runs were not received");
  },
});

export const batchTriggerSequentiallyTask = task({
  id: "batch-trigger-sequentially",
  retry: {
    maxAttempts: 1,
  },
  run: async ({
    count = 20,
    wait = false,
    triggerSequentially = true,
  }: {
    count: number;
    wait: boolean;
    triggerSequentially: boolean;
  }) => {
    if (wait) {
      return await batchV2TestChild.batchTriggerAndWait(
        Array.from({ length: count }, (_, i) => ({
          payload: { foo: `bar${i}` },
        })),
        {
          triggerSequentially,
        }
      );
    } else {
      return await batchV2TestChild.batchTrigger(
        Array.from({ length: count }, (_, i) => ({
          payload: { foo: `bar${i}` },
        })),
        {
          triggerSequentially,
        }
      );
    }
  },
});

export const batchV2TestChild = task({
  id: "batch-v2-test-child",
  queue: {
    concurrencyLimit: 10,
  },
  run: async (payload: any) => {
    return payload;
  },
});

export const batchAutoIdempotencyKeyTask = task({
  id: "batch-auto-idempotency-key",
  retry: {
    maxAttempts: 3,
  },
  run: async () => {
    const idempotencyKey = await idempotencyKeys.create("first-batch-1");

    logger.debug("Idempotency key", { idempotencyKey });

    const response1 = await batchAutoIdempotencyKeyChild.batchTrigger(
      [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }],
      {
        idempotencyKey: idempotencyKey,
      }
    );

    logger.debug("Response 1", { response1 });

    const idempotencyKey2 = await idempotencyKeys.create("first-batch-2", { scope: "global" });

    logger.debug("Idempotency key 2", { idempotencyKey2 });

    const response2 = await batchAutoIdempotencyKeyChild.batchTrigger(
      [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }],
      {
        idempotencyKey: idempotencyKey2,
      }
    );

    logger.debug("Response 2", { response2 });

    const idempotencyKey3 = await idempotencyKeys.create(randomUUID());

    logger.debug("Idempotency key 3", { idempotencyKey3 });

    const response3 = await batchAutoIdempotencyKeyChild.batchTrigger(
      [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }],
      {
        idempotencyKey: idempotencyKey3,
      }
    );

    logger.debug("Response 3", { response3 });

    throw new Error("Forcing a retry to see if another batch is created");
  },
});

export const batchAutoIdempotencyKeyChild = task({
  id: "batch-auto-idempotency-key-child",
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: any) => {
    return payload;
  },
});

export const batchTriggerIdempotencyKeyTest = task({
  id: "batch-trigger-idempotency-key-test",
  retry: {
    maxAttempts: 1,
  },
  run: async () => {
    // Trigger a batch of 2 items with the same idempotency key
    await batchV2TestChild.batchTrigger(
      [
        { payload: { foo: "bar" }, options: { idempotencyKey: "test-idempotency-key" } },
        { payload: { foo: "baz" }, options: { idempotencyKey: "test-idempotency-key" } },
      ],
      {
        triggerSequentially: true,
      }
    );

    // Now trigger a batch of 21 items, with just the last one having an idempotency key
    await batchV2TestChild.batchTrigger(
      Array.from({ length: 20 }, (_, i) => ({
        payload: { foo: `bar${i}` },
        options: {},
      })).concat([
        {
          payload: { foo: "baz" },
          options: { idempotencyKey: "test-idempotency-key-2" },
        },
      ]),
      {
        triggerSequentially: true,
      }
    );

    // Now while that batch is being processed in the background, lets trigger the same task with that idempotency key
    await batchV2TestChild.trigger({ foo: "baz" }, { idempotencyKey: "test-idempotency-key-2" });
  },
});
