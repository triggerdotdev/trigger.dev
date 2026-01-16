import { batch, idempotencyKeys, logger, task, timeout, usage, wait } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";
import { childTask } from "./example.js";

export const idempotency = task({
  id: "idempotency",
  maxDuration: 60,
  run: async (payload: any, { ctx }) => {
    logger.log("Hello, world from the parent", { payload });

    const successfulKey = await idempotencyKeys.create("a", { scope: "global" });

    const child1 = await childTask.triggerAndWait(
      { message: "Hello, world!", duration: 500, failureChance: 0 },
      { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" }
    );
    logger.log("Child 1", { child1 });
    const child2 = await childTask.triggerAndWait(
      { message: "Hello, world!", duration: 500 },
      { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" }
    );
    logger.log("Child 2", { child2 });
    await childTask.trigger(
      { message: "Hello, world!", duration: 500, failureChance: 0 },
      { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" }
    );

    const failureKey = await idempotencyKeys.create("b", { scope: "global" });

    const child3 = await childTask.triggerAndWait(
      { message: "Hello, world!", duration: 500, failureChance: 1 },
      { idempotencyKey: failureKey, idempotencyKeyTTL: "120s" }
    );
    logger.log("Child 3", { child3 });
    const child4 = await childTask.triggerAndWait(
      { message: "Hello, world!", duration: 500, failureChance: 1 },
      { idempotencyKey: failureKey, idempotencyKeyTTL: "120s" }
    );
    logger.log("Child 4", { child4 });

    const anotherKey = await idempotencyKeys.create("c", { scope: "global" });

    const batch1 = await childTask.batchTriggerAndWait([
      {
        payload: { message: "Hello, world!" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" },
      },
      {
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "120s" },
      },
      {
        payload: { message: "Hello, world 3", duration: 500, failureChance: 0 },
        options: { idempotencyKey: anotherKey, idempotencyKeyTTL: "120s" },
      },
    ]);
    logger.log("Batch 1", { batch1 });

    await childTask.batchTrigger([
      {
        payload: { message: "Hello, world!" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" },
      },
      {
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "120s" },
      },
    ]);

    const results2 = await batch.triggerAndWait<typeof childTask>([
      {
        id: "child",
        payload: { message: "Hello, world !" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "60s" },
      },
      {
        id: "child",
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "60s" },
      },
    ]);
    logger.log("Results 2", { results2 });

    const results3 = await batch.triggerByTask([
      {
        task: childTask,
        payload: { message: "Hello, world !" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "60s" },
      },
      {
        task: childTask,
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "60s" },
      },
    ]);
    logger.log("Results 3", { results3 });

    const results4 = await batch.triggerByTaskAndWait([
      {
        task: childTask,
        payload: { message: "Hello, world !" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "60s" },
      },
      {
        task: childTask,
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "60s" },
      },
    ]);
    logger.log("Results 4", { results4 });
  },
});

export const idempotencyBatch = task({
  id: "idempotency-batch",
  maxDuration: 60,
  run: async ({ additionalItems }: { additionalItems?: 2 }) => {
    const successfulKey = await idempotencyKeys.create("a", { scope: "global" });
    const failureKey = await idempotencyKeys.create("b", { scope: "global" });
    const anotherKey = await idempotencyKeys.create("c", { scope: "global" });
    const batchKey = await idempotencyKeys.create("batch", { scope: "global" });

    const moreItems = Array.from({ length: additionalItems ?? 0 }, (_, i) => ({
      payload: { message: `Hello, world ${i}!` },
      options: { idempotencyKey: `key-${i}`, idempotencyKeyTTL: "120s" },
    }));

    const batch1 = await childTask.batchTriggerAndWait(
      [
        {
          payload: { message: "Hello, world!" },
          options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" },
        },
        {
          payload: { message: "Hello, world 2!" },
          options: { idempotencyKey: failureKey, idempotencyKeyTTL: "120s" },
        },
        {
          payload: { message: "Hello, world 3", duration: 500, failureChance: 0 },
        },
        // Include runs in the same batch with the same idempotencyKeys
        // I'm sure people will do this, even though it doesn't make sense
        {
          payload: { message: "Hello, world!" },
          options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" },
        },
        {
          payload: { message: "Hello, world 2!" },
          options: { idempotencyKey: failureKey, idempotencyKeyTTL: "120s" },
        },
        ...moreItems,
      ],
      {
        idempotencyKey: batchKey,
        idempotencyKeyTTL: "120s",
      }
    );
    logger.log("Batch 1", { batch1 });

    const b = await batch.retrieve(batch1.id);
    logger.log("Batch retrieve", { ...b });

    const batch2 = await childTask.batchTriggerAndWait(
      [
        {
          payload: { message: "Hello, world!" },
          options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" },
        },
        {
          payload: { message: "Hello, world 2!" },
          options: { idempotencyKey: failureKey, idempotencyKeyTTL: "120s" },
        },
        {
          payload: { message: "Hello, world 3", duration: 500, failureChance: 0 },
        },
        ...moreItems,
      ],
      {
        idempotencyKey: batchKey,
        idempotencyKeyTTL: "120s",
      }
    );
    logger.log("Batch 1", { batch1 });

    await childTask.batchTrigger([
      {
        payload: { message: "Hello, world!" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" },
      },
      {
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "120s" },
      },
    ]);

    await childTask.batchTrigger([
      {
        payload: { message: "Hello, world!" },
      },
      {
        payload: { message: "Hello, world 2!" },
      },
    ]);

    const results2 = await batch.triggerAndWait<typeof childTask>([
      {
        id: "child",
        payload: { message: "Hello, world !" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "60s" },
      },
      {
        id: "child",
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "60s" },
      },
    ]);
    logger.log("Results 2", { results2 });

    const results3 = await batch.triggerByTask([
      {
        task: childTask,
        payload: { message: "Hello, world !" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "60s" },
      },
      {
        task: childTask,
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "60s" },
      },
    ]);
    logger.log("Results 3", { results3 });

    const results4 = await batch.triggerByTaskAndWait([
      {
        task: childTask,
        payload: { message: "Hello, world !" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "60s" },
      },
      {
        task: childTask,
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "60s" },
      },
    ]);
    logger.log("Results 4", { results4 });
  },
});

export const idempotencyTriggerByTaskAndWait = task({
  id: "idempotency-trigger-by-task-and-wait",
  maxDuration: 60,
  run: async () => {
    const successfulKey = await idempotencyKeys.create("a", { scope: "global" });
    const failureKey = await idempotencyKeys.create("b", { scope: "global" });

    const results1 = await batch.triggerByTaskAndWait([
      {
        task: childTask,
        payload: { message: "Hello, world !" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "60s" },
      },
      {
        task: childTask,
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "60s" },
      },
    ]);
    logger.log("Results 1", { results1 });

    const results2 = await batch.triggerByTaskAndWait([
      {
        task: childTask,
        payload: { message: "Hello, world !" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "60s" },
      },
      {
        task: childTask,
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "60s" },
      },
    ]);
    logger.log("Results 2", { results2 });
  },
});

export const idempotencyTriggerAndWaitWithInProgressRun = task({
  id: "idempotency-trigger-and-wait-with-in-progress-run",
  maxDuration: 60,
  run: async () => {
    await childTask.trigger(
      { message: "Hello, world!", duration: 5000, failureChance: 100 },
      {
        idempotencyKey: "b",
      }
    );
    await childTask.triggerAndWait(
      { message: "Hello, world!", duration: 5000, failureChance: 0 },
      {
        idempotencyKey: "b",
      }
    );
  },
});

// Test task for verifying idempotencyKeyOptions storage (TRI-4352)
export const idempotencyKeyOptionsChild = task({
  id: "idempotency-key-options-child",
  run: async (payload: { message: string }, { ctx }) => {
    // Log the idempotency key from context - should be the user-provided key, not the hash
    logger.log("Child task context", {
      idempotencyKey: ctx.run.idempotencyKey,
      idempotencyKeyScope: ctx.run.idempotencyKeyScope,
      runId: ctx.run.id,
    });

    return {
      receivedIdempotencyKey: ctx.run.idempotencyKey,
      receivedIdempotencyKeyScope: ctx.run.idempotencyKeyScope,
      message: payload.message,
    };
  },
});


export const idempotencyKeyOptionsTest = task({
  id: "idempotency-key-options-test",
  maxDuration: 60,
  run: async (payload: any, { ctx }) => {
    logger.log("Testing idempotencyKeyOptions feature (TRI-4352)");

    // Test 1: Create key with "run" scope (default)
    const runScopedKey = await idempotencyKeys.create("my-run-scoped-key");
    logger.log("Created run-scoped key", { key: runScopedKey.toString() });

    const result1 = await idempotencyKeyOptionsChild.triggerAndWait(
      { message: "Test with run scope" },
      { idempotencyKey: runScopedKey, idempotencyKeyTTL: "60s" }
    );
    logger.log("Result 1 (run scope)", { result: result1 });

    // Test 2: Create key with "global" scope
    const globalScopedKey = await idempotencyKeys.create("my-global-scoped-key", {
      scope: "global",
    });
    logger.log("Created global-scoped key", { key: globalScopedKey.toString() });

    const result2 = await idempotencyKeyOptionsChild.triggerAndWait(
      { message: "Test with global scope" },
      { idempotencyKey: globalScopedKey, idempotencyKeyTTL: "60s" }
    );
    logger.log("Result 2 (global scope)", { result: result2 });

    // Test 3: Create key with "attempt" scope
    const attemptScopedKey = await idempotencyKeys.create("my-attempt-scoped-key", {
      scope: "attempt",
    });
    logger.log("Created attempt-scoped key", { key: attemptScopedKey.toString() });

    const result3 = await idempotencyKeyOptionsChild.triggerAndWait(
      { message: "Test with attempt scope" },
      { idempotencyKey: attemptScopedKey, idempotencyKeyTTL: "60s" }
    );
    logger.log("Result 3 (attempt scope)", { result: result3 });

    // Test 4: Create key with array input
    const arrayKey = await idempotencyKeys.create(["user", "123", "action"]);
    logger.log("Created array key", { key: arrayKey.toString() });

    const result4 = await idempotencyKeyOptionsChild.triggerAndWait(
      { message: "Test with array key" },
      { idempotencyKey: arrayKey, idempotencyKeyTTL: "60s" }
    );
    logger.log("Result 4 (array key)", { result: result4 });

    return {
      results: [
        { scope: "run", idempotencyKey: result1.ok ? result1.output?.receivedIdempotencyKey : null },
        {
          scope: "global",
          idempotencyKey: result2.ok ? result2.output?.receivedIdempotencyKey : null,
        },
        {
          scope: "attempt",
          idempotencyKey: result3.ok ? result3.output?.receivedIdempotencyKey : null,
        },
        { scope: "array", idempotencyKey: result4.ok ? result4.output?.receivedIdempotencyKey : null },
      ],
    };
  },
});
