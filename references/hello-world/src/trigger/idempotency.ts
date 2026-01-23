import { batch, idempotencyKeys, logger, runs, task, timeout, usage, wait } from "@trigger.dev/sdk/v3";
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

// Test task for verifying idempotencyKeys.reset works with the new API (TRI-4352)
export const idempotencyKeyResetTest = task({
  id: "idempotency-key-reset-test",
  maxDuration: 120,
  run: async (payload: any, { ctx }) => {
    logger.log("Testing idempotencyKeys.reset feature (TRI-4352)");

    const testResults: Array<{
      test: string;
      success: boolean;
      details: Record<string, unknown>;
    }> = [];

    // Test 1: Reset using IdempotencyKey object (options extracted automatically)
    {
      const key = await idempotencyKeys.create("reset-test-key-1", { scope: "global" });
      logger.log("Test 1: Created global-scoped key", { key: key.toString() });

      // First trigger - should create a new run
      const result1 = await idempotencyKeyOptionsChild.triggerAndWait(
        { message: "First trigger" },
        { idempotencyKey: key, idempotencyKeyTTL: "300s" }
      );
      const firstRunId = result1.ok ? result1.id : null;
      logger.log("Test 1: First trigger", { runId: firstRunId });

      // Second trigger - should be deduplicated (same run ID)
      const result2 = await idempotencyKeyOptionsChild.triggerAndWait(
        { message: "Second trigger (should dedupe)" },
        { idempotencyKey: key, idempotencyKeyTTL: "300s" }
      );
      const secondRunId = result2.ok ? result2.id : null;
      logger.log("Test 1: Second trigger (dedupe check)", { runId: secondRunId });

      const wasDeduplicated = firstRunId === secondRunId;

      // Reset the idempotency key using the IdempotencyKey object
      logger.log("Test 1: Resetting idempotency key using IdempotencyKey object");
      await idempotencyKeys.reset("idempotency-key-options-child", key);

      // Third trigger - should create a NEW run after reset
      const result3 = await idempotencyKeyOptionsChild.triggerAndWait(
        { message: "Third trigger (after reset)" },
        { idempotencyKey: key, idempotencyKeyTTL: "300s" }
      );
      const thirdRunId = result3.ok ? result3.id : null;
      logger.log("Test 1: Third trigger (after reset)", { runId: thirdRunId });

      const wasResetSuccessful = thirdRunId !== firstRunId && thirdRunId !== null;

      testResults.push({
        test: "Reset with IdempotencyKey object (global scope)",
        success: wasDeduplicated && wasResetSuccessful,
        details: {
          firstRunId,
          secondRunId,
          thirdRunId,
          wasDeduplicated,
          wasResetSuccessful,
        },
      });
    }

    // Test 2: Reset using raw string with scope option
    {
      const keyString = "reset-test-key-2";
      const key = await idempotencyKeys.create(keyString, { scope: "global" });
      logger.log("Test 2: Created global-scoped key from string", { key: key.toString() });

      // First trigger
      const result1 = await idempotencyKeyOptionsChild.triggerAndWait(
        { message: "First trigger (raw string test)" },
        { idempotencyKey: key, idempotencyKeyTTL: "300s" }
      );
      const firstRunId = result1.ok ? result1.id : null;
      logger.log("Test 2: First trigger", { runId: firstRunId });

      // Reset using raw string + scope option
      logger.log("Test 2: Resetting idempotency key using raw string + scope");
      await idempotencyKeys.reset("idempotency-key-options-child", keyString, { scope: "global" });

      // Second trigger - should create a NEW run after reset
      const result2 = await idempotencyKeyOptionsChild.triggerAndWait(
        { message: "Second trigger (after reset with raw string)" },
        { idempotencyKey: key, idempotencyKeyTTL: "300s" }
      );
      const secondRunId = result2.ok ? result2.id : null;
      logger.log("Test 2: Second trigger (after reset)", { runId: secondRunId });

      const wasResetSuccessful = secondRunId !== firstRunId && secondRunId !== null;

      testResults.push({
        test: "Reset with raw string + scope option (global scope)",
        success: wasResetSuccessful,
        details: {
          firstRunId,
          secondRunId,
          wasResetSuccessful,
        },
      });
    }

    // Test 3: Reset with run scope (uses current run context)
    {
      const key = await idempotencyKeys.create("reset-test-key-3", { scope: "run" });
      logger.log("Test 3: Created run-scoped key", { key: key.toString() });

      // First trigger
      const result1 = await idempotencyKeyOptionsChild.triggerAndWait(
        { message: "First trigger (run scope)" },
        { idempotencyKey: key, idempotencyKeyTTL: "300s" }
      );
      const firstRunId = result1.ok ? result1.id : null;
      logger.log("Test 3: First trigger", { runId: firstRunId });

      // Reset using IdempotencyKey (run scope - should use current run context)
      logger.log("Test 3: Resetting idempotency key with run scope");
      await idempotencyKeys.reset("idempotency-key-options-child", key);

      // Second trigger - should create a NEW run after reset
      const result2 = await idempotencyKeyOptionsChild.triggerAndWait(
        { message: "Second trigger (after reset, run scope)" },
        { idempotencyKey: key, idempotencyKeyTTL: "300s" }
      );
      const secondRunId = result2.ok ? result2.id : null;
      logger.log("Test 3: Second trigger (after reset)", { runId: secondRunId });

      const wasResetSuccessful = secondRunId !== firstRunId && secondRunId !== null;

      testResults.push({
        test: "Reset with IdempotencyKey object (run scope)",
        success: wasResetSuccessful,
        details: {
          firstRunId,
          secondRunId,
          wasResetSuccessful,
          parentRunId: ctx.run.id,
        },
      });
    }

    // Summary
    const allPassed = testResults.every((r) => r.success);
    logger.log("Test summary", { allPassed, testResults });

    return {
      allPassed,
      testResults,
    };
  },
});
