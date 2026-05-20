import { logger, schemaTask, task, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { setTimeout } from "timers/promises";

// A simple child task that does some work and returns a result
const childWork = schemaTask({
  id: "child-work",
  schema: z.object({
    label: z.string(),
    delayMs: z.number().default(1000),
    shouldFail: z.boolean().default(false),
  }),
  run: async ({ label, delayMs, shouldFail }) => {
    logger.info(`Child task "${label}" starting`, { delayMs, shouldFail });
    await setTimeout(delayMs);
    if (shouldFail) {
      throw new Error(`Child task "${label}" intentionally failed`);
    }
    logger.info(`Child task "${label}" done`);
    return { label, completedAt: new Date().toISOString() };
  },
});

// Test 1: Basic triggerAndSubscribe — single child task
export const testTriggerAndSubscribe = task({
  id: "test-trigger-and-subscribe",
  run: async () => {
    logger.info("Starting single triggerAndSubscribe test");

    const result = await childWork
      .triggerAndSubscribe({ label: "single", delayMs: 2000 })
      .unwrap();

    logger.info("Got result", { result });
    return result;
  },
});

// Test 2: Parallel triggerAndSubscribe — multiple children concurrently
export const testParallelSubscribe = task({
  id: "test-parallel-subscribe",
  run: async () => {
    logger.info("Starting parallel triggerAndSubscribe test");

    // This would fail with triggerAndWait due to preventMultipleWaits
    const [result1, result2, result3] = await Promise.all([
      childWork.triggerAndSubscribe({ label: "parallel-1", delayMs: 2000 }).unwrap(),
      childWork.triggerAndSubscribe({ label: "parallel-2", delayMs: 3000 }).unwrap(),
      childWork.triggerAndSubscribe({ label: "parallel-3", delayMs: 1000 }).unwrap(),
    ]);

    logger.info("All parallel tasks complete", { result1, result2, result3 });
    return { result1, result2, result3 };
  },
});

// Test 3: Abort with cancelOnAbort: true (default) — child run gets cancelled
export const testAbortWithCancel = task({
  id: "test-abort-with-cancel",
  run: async () => {
    logger.info("Starting abort test (cancelOnAbort: true) — child should be cancelled");

    const controller = new AbortController();

    // Abort after 2 seconds
    setTimeout(2000).then(() => {
      logger.info("Firing abort signal");
      controller.abort();
    });

    try {
      const result = await childWork
        .triggerAndSubscribe(
          { label: "will-be-cancelled", delayMs: 10000 },
          { signal: controller.signal }
        )
        .unwrap();

      logger.error("Unexpected: task completed without being cancelled", { result });
      return { aborted: false, childCancelled: false, result };
    } catch (error) {
      logger.info("Expected: subscription aborted and child cancelled", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { aborted: true, childCancelled: true };
    }
  },
});

// Test 4: Abort with cancelOnAbort: false — child run keeps running
export const testAbortWithoutCancel = task({
  id: "test-abort-without-cancel",
  run: async () => {
    logger.info("Starting abort test (cancelOnAbort: false) — child should keep running");

    const controller = new AbortController();

    // Abort after 2 seconds
    setTimeout(2000).then(() => {
      logger.info("Firing abort signal");
      controller.abort();
    });

    try {
      const result = await childWork
        .triggerAndSubscribe(
          { label: "keeps-running", delayMs: 5000 },
          { signal: controller.signal, cancelOnAbort: false }
        )
        .unwrap();

      logger.error("Unexpected: task completed (subscription should have been aborted)", {
        result,
      });
      return { aborted: false, result };
    } catch (error) {
      logger.info("Expected: subscription aborted but child still running", {
        error: error instanceof Error ? error.message : String(error),
      });
      // The child task should still complete on its own — we just stopped listening
      return { aborted: true, childCancelled: false };
    }
  },
});

// Test 5: Abort signal already aborted before calling triggerAndSubscribe
export const testAbortAlreadyAborted = task({
  id: "test-abort-already-aborted",
  run: async () => {
    logger.info("Starting pre-aborted signal test");

    const controller = new AbortController();
    controller.abort("pre-aborted");

    try {
      const result = await childWork
        .triggerAndSubscribe(
          { label: "should-not-run", delayMs: 1000 },
          { signal: controller.signal }
        )
        .unwrap();

      logger.error("Unexpected: task completed", { result });
      return { aborted: false };
    } catch (error) {
      logger.info("Expected: immediately aborted", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { aborted: true };
    }
  },
});

// Test 6: Standalone tasks.triggerAndSubscribe
export const testStandaloneSubscribe = task({
  id: "test-standalone-subscribe",
  run: async () => {
    logger.info("Starting standalone triggerAndSubscribe test");

    const result = await tasks
      .triggerAndSubscribe<typeof childWork>("child-work", {
        label: "standalone",
        delayMs: 1500,
      })
      .unwrap();

    logger.info("Got result", { result });
    return result;
  },
});

// Test 7: Result object without .unwrap() — success case
export const testResultSuccess = task({
  id: "test-result-success",
  run: async () => {
    const result = await childWork.triggerAndSubscribe({
      label: "result-success",
      delayMs: 1000,
    });

    logger.info("Result object", {
      ok: result.ok,
      id: result.id,
      taskIdentifier: result.taskIdentifier,
    });

    if (result.ok) {
      logger.info("Success output", { output: result.output });
      return { ok: true, output: result.output, id: result.id };
    } else {
      logger.error("Unexpected failure", { error: result.error });
      return { ok: false, error: String(result.error) };
    }
  },
});

// Test 8: Result object without .unwrap() — failure case
export const testResultFailure = task({
  id: "test-result-failure",
  retry: { maxAttempts: 1 },
  run: async () => {
    const result = await childWork.triggerAndSubscribe({
      label: "result-failure",
      delayMs: 500,
      shouldFail: true,
    });

    logger.info("Result object", {
      ok: result.ok,
      id: result.id,
      taskIdentifier: result.taskIdentifier,
    });

    if (result.ok) {
      logger.error("Unexpected success", { output: result.output });
      return { ok: true, output: result.output };
    } else {
      logger.info("Expected failure", { error: String(result.error) });
      return { ok: false, error: String(result.error), id: result.id };
    }
  },
});

// Test 9: .unwrap() on a failed child — should throw SubtaskUnwrapError
export const testUnwrapFailure = task({
  id: "test-unwrap-failure",
  retry: { maxAttempts: 1 },
  run: async () => {
    try {
      const output = await childWork
        .triggerAndSubscribe({
          label: "unwrap-failure",
          delayMs: 500,
          shouldFail: true,
        })
        .unwrap();

      logger.error("Unexpected: unwrap succeeded", { output });
      return { threw: false, output };
    } catch (error) {
      logger.info("Expected: unwrap threw", {
        name: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        threw: true,
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

// Test 10: Parallel with mixed success/failure
export const testParallelMixed = task({
  id: "test-parallel-mixed",
  retry: { maxAttempts: 1 },
  run: async () => {
    const [success, failure] = await Promise.all([
      childWork.triggerAndSubscribe({ label: "mixed-success", delayMs: 1000 }),
      childWork.triggerAndSubscribe({ label: "mixed-failure", delayMs: 500, shouldFail: true }),
    ]);

    logger.info("Results", {
      success: { ok: success.ok, output: success.ok ? success.output : null },
      failure: { ok: failure.ok, error: !failure.ok ? String(failure.error) : null },
    });

    return {
      successOk: success.ok,
      successOutput: success.ok ? success.output : null,
      failureOk: failure.ok,
      failureError: !failure.ok ? String(failure.error) : null,
    };
  },
});
