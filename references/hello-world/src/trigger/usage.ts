import { logger, task, wait, usage, runs } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";
import assert from "node:assert";

export const usageExampleTask = task({
  id: "usage-example",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 1000,
    factor: 1.5,
  },
  run: async (payload: { throwError: boolean }, { ctx }) => {
    logger.info("run.ctx", { ctx });

    await setTimeout(1000);

    const currentUsage = usage.getCurrent();

    logger.info("currentUsage", { currentUsage });

    if (payload.throwError && ctx.attempt.number === 1) {
      throw new Error("Forced error to cause a retry");
    }

    await setTimeout(5000);

    const currentUsage2 = usage.getCurrent();

    logger.info("currentUsage2", { currentUsage2 });

    return {
      message: "Hello, world!",
    };
  },
});

/**
 * Test task to verify usage tracking works correctly after moving updates to run engine.
 *
 * Tests:
 * 1. usageDurationMs accumulates across attempts (retries)
 * 2. costInCents is only calculated for non-dev environments
 * 3. Usage is tracked and returned correctly
 *
 * Run with:
 *   - { causeRetry: false } for simple usage test
 *   - { causeRetry: true } for retry accumulation test
 */
export const usageTrackingTestTask = task({
  id: "usage-tracking-test",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 200,
    factor: 1,
  },
  run: async (payload: { causeRetry?: boolean; workDurationMs?: number }, { ctx }) => {
    const workDuration = payload.workDurationMs ?? 2000;
    const isDev = ctx.environment.type === "DEVELOPMENT";

    logger.info("Starting usage tracking test", {
      attemptNumber: ctx.attempt.number,
      environmentType: ctx.environment.type,
      isDev,
      workDuration,
      causeRetry: payload.causeRetry,
    });

    // Get usage at start of this attempt
    const usageAtStart = usage.getCurrent();
    logger.info("Usage at attempt start", {
      attemptNumber: ctx.attempt.number,
      usageAtStart,
    });

    // Do some "work" to accumulate usage duration
    const workStart = Date.now();
    await setTimeout(workDuration);
    const actualWorkTime = Date.now() - workStart;

    // Get usage after work
    const usageAfterWork = usage.getCurrent();
    logger.info("Usage after work", {
      attemptNumber: ctx.attempt.number,
      usageAfterWork,
      actualWorkTimeMs: actualWorkTime,
      attemptDurationDelta:
        usageAfterWork.compute.attempt.durationMs - usageAtStart.compute.attempt.durationMs,
    });

    // Cause a retry on first attempt if requested
    if (payload.causeRetry && ctx.attempt.number === 1) {
      logger.info("Throwing error to cause retry - usage from this attempt should accumulate");
      throw new Error("Intentional error to test usage accumulation across retries");
    }

    // Log expectations for verification
    logger.info("Usage tracking test completed", {
      attemptNumber: ctx.attempt.number,
      finalUsage: usageAfterWork,
      environmentType: ctx.environment.type,
      expectations: {
        usageDurationMs: "Should be > 0 and reflect actual CPU time",
        costInCents: isDev
          ? "Should be 0 (dev environment - no cost tracking)"
          : "Should be > 0 (calculated from usageDurationMs * machine centsPerMs)",
        retryAccumulation: payload.causeRetry
          ? "If this is attempt 2+, usageDurationMs should include time from previous attempts"
          : "N/A - no retry",
      },
    });

    return {
      success: true,
      attemptNumber: ctx.attempt.number,
      environmentType: ctx.environment.type,
      finalUsage: usageAfterWork,
      isDev,
      note: isDev
        ? "costInCents will be 0 in dev - deploy to staging/prod to test cost calculation"
        : "costInCents should reflect accumulated usage cost",
    };
  },
});

/**
 * Parent task that triggers usageTrackingTestTask and verifies the usage values
 * are correctly stored in the database via runs.retrieve().
 *
 * This tests the full flow:
 * 1. Trigger child task and wait for completion
 * 2. Use runs.retrieve() to fetch the run from the database
 * 3. Verify usageDurationMs > 0
 * 4. Verify costInCents behavior based on environment type
 */
export const usageVerificationParentTask = task({
  id: "usage-verification-parent",
  run: async (payload: { causeRetry?: boolean; workDurationMs?: number }, { ctx }) => {
    const isDev = ctx.environment.type === "DEVELOPMENT";

    logger.info("Starting usage verification parent task", {
      environmentType: ctx.environment.type,
      isDev,
      causeRetry: payload.causeRetry,
      workDurationMs: payload.workDurationMs,
    });

    // Trigger the child task and wait for it to complete
    const childResult = await usageTrackingTestTask.triggerAndWait({
      causeRetry: payload.causeRetry,
      workDurationMs: payload.workDurationMs ?? 2000,
    });

    if (!childResult.ok) {
      throw new Error(`Child task failed: ${JSON.stringify(childResult.error)}`);
    }

    logger.info("Child task completed", {
      childRunId: childResult.id,
      childOutput: childResult.output,
    });

    // Retrieve the run from the database to verify usage values were stored
    const retrievedRun = await runs.retrieve(childResult.id);

    logger.info("Retrieved run from database", {
      runId: retrievedRun.id,
      status: retrievedRun.status,
      durationMs: retrievedRun.durationMs,
      costInCents: retrievedRun.costInCents,
      baseCostInCents: retrievedRun.baseCostInCents,
    });

    // Verify usageDurationMs (durationMs in the API response) is greater than 0
    assert.ok(
      retrievedRun.durationMs > 0,
      `Expected durationMs > 0, got ${retrievedRun.durationMs}`
    );

    // For retry test, verify duration accumulated across attempts
    if (payload.causeRetry) {
      // With a retry, we should have at least 2x the work duration (attempt 1 + attempt 2)
      const minExpectedDuration = (payload.workDurationMs ?? 2000) * 1.5; // Allow some variance
      assert.ok(
        retrievedRun.durationMs >= minExpectedDuration,
        `Expected durationMs >= ${minExpectedDuration} for retry test (got ${retrievedRun.durationMs})`
      );
      logger.info("✅ Retry accumulation verified - duration includes time from both attempts");
    }

    // Verify costInCents based on environment type
    if (isDev) {
      // In dev, cost should be 0
      assert.strictEqual(
        retrievedRun.costInCents,
        0,
        `Expected costInCents to be 0 in dev environment, got ${retrievedRun.costInCents}`
      );
      logger.info("✅ Dev environment verified - costInCents is 0 as expected");
    } else {
      // In non-dev, cost should be > 0
      assert.ok(
        retrievedRun.costInCents > 0,
        `Expected costInCents > 0 in ${ctx.environment.type} environment, got ${retrievedRun.costInCents}`
      );
      logger.info(
        `✅ ${ctx.environment.type} environment verified - costInCents is ${retrievedRun.costInCents}`
      );
    }

    logger.info("✅ All usage verification checks passed!", {
      durationMs: retrievedRun.durationMs,
      costInCents: retrievedRun.costInCents,
      baseCostInCents: retrievedRun.baseCostInCents,
      environmentType: ctx.environment.type,
      hadRetry: payload.causeRetry,
    });

    return {
      success: true,
      childRunId: childResult.id,
      durationMs: retrievedRun.durationMs,
      costInCents: retrievedRun.costInCents,
      baseCostInCents: retrievedRun.baseCostInCents,
      environmentType: ctx.environment.type,
      hadRetry: payload.causeRetry ?? false,
    };
  },
});
