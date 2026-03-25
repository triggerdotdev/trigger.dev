import { logger, task, tasks, RateLimitError } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";

/**
 * A simple no-op task that does minimal work.
 * Used as the target for rate limit stress testing.
 */
export const noopTask = task({
  id: "noop-task",
  retry: { maxAttempts: 1 },
  run: async (payload: { index: number }) => {
    return { index: payload.index, timestamp: Date.now() };
  },
});

/**
 * Stress test task that triggers many runs rapidly to hit the API rate limit.
 * Fires triggers as fast as possible for a set duration, then stops.
 *
 * Note: Already-triggered runs will continue to execute after the test completes.
 *
 * Default rate limits (per environment API key):
 * - Free: 1,200 runs bucket, refills 100 runs/10 sec
 * - Hobby/Pro: 5,000 runs bucket, refills 500 runs/5 sec
 *
 * Run with: `npx trigger.dev@latest dev` then trigger this task from the dashboard
 */
export const rateLimitStressTest = task({
  id: "rate-limit-stress-test",
  maxDuration: 120,
  run: async (payload: {
    /** How long to run the test in seconds (default: 5) */
    durationSeconds?: number;
    /** How many triggers to fire in parallel per batch (default: 100) */
    batchSize?: number;
  }) => {
    const durationSeconds = payload.durationSeconds ?? 5;
    const batchSize = payload.batchSize ?? 100;
    const durationMs = durationSeconds * 1000;

    logger.info("Starting rate limit stress test", {
      durationSeconds,
      batchSize,
    });

    const start = Date.now();
    let totalAttempted = 0;
    let totalSuccess = 0;
    let totalRateLimited = 0;
    let totalOtherErrors = 0;
    let batchCount = 0;

    // Keep firing batches until time runs out
    while (Date.now() - start < durationMs) {
      batchCount++;
      const batchStart = Date.now();
      const elapsed = batchStart - start;
      const remaining = durationMs - elapsed;

      logger.info(`Batch ${batchCount} starting`, {
        elapsedMs: elapsed,
        remainingMs: remaining,
        totalAttempted,
        totalSuccess,
        totalRateLimited,
      });

      // Fire a batch of triggers
      const promises = Array.from({ length: batchSize }, async (_, i) => {
        // Check if we've exceeded time before each trigger
        if (Date.now() - start >= durationMs) {
          return { skipped: true };
        }

        const index = totalAttempted + i;
        try {
          await tasks.trigger<typeof noopTask>("noop-task", { index });
          return { success: true, rateLimited: false };
        } catch (error) {
          if (error instanceof RateLimitError) {
            return { success: false, rateLimited: true, resetInMs: error.millisecondsUntilReset };
          }
          return { success: false, rateLimited: false };
        }
      });

      const results = await Promise.all(promises);

      const batchSuccess = results.filter((r) => "success" in r && r.success).length;
      const batchRateLimited = results.filter((r) => "rateLimited" in r && r.rateLimited).length;
      const batchOtherErrors = results.filter(
        (r) => "success" in r && !r.success && !("rateLimited" in r && r.rateLimited)
      ).length;
      const batchSkipped = results.filter((r) => "skipped" in r && r.skipped).length;

      totalAttempted += batchSize - batchSkipped;
      totalSuccess += batchSuccess;
      totalRateLimited += batchRateLimited;
      totalOtherErrors += batchOtherErrors;

      // Log rate limit hits
      const rateLimitedResult = results.find((r) => "rateLimited" in r && r.rateLimited);
      if (rateLimitedResult && "resetInMs" in rateLimitedResult) {
        logger.warn("Rate limit hit!", {
          batch: batchCount,
          resetInMs: rateLimitedResult.resetInMs,
          totalRateLimited,
        });
      }

      // Small delay between batches to not overwhelm
      await setTimeout(50);
    }

    const duration = Date.now() - start;

    logger.info("Stress test completed", {
      actualDurationMs: duration,
      totalAttempted,
      totalSuccess,
      totalRateLimited,
      totalOtherErrors,
      batchCount,
    });

    return {
      config: {
        durationSeconds,
        batchSize,
      },
      results: {
        actualDurationMs: duration,
        totalAttempted,
        totalSuccess,
        totalRateLimited,
        totalOtherErrors,
        batchCount,
        hitRateLimit: totalRateLimited > 0,
        triggersPerSecond: Math.round((totalAttempted / duration) * 1000),
      },
    };
  },
});

/**
 * Sustained load test - maintains a steady rate of triggers over time.
 * Useful for seeing how rate limits behave under sustained load.
 *
 * Note: Successfully triggered runs will continue executing after this test completes.
 */
export const sustainedLoadTest = task({
  id: "sustained-load-test",
  maxDuration: 300,
  run: async (payload: {
    /** Triggers per second to attempt (default: 100) */
    triggersPerSecond?: number;
    /** Duration in seconds (default: 20) */
    durationSeconds?: number;
  }) => {
    const triggersPerSecond = payload.triggersPerSecond ?? 100;
    const durationSeconds = payload.durationSeconds ?? 20;

    const intervalMs = 1000 / triggersPerSecond;
    const totalTriggers = triggersPerSecond * durationSeconds;

    logger.info("Starting sustained load test", {
      triggersPerSecond,
      durationSeconds,
      totalTriggers,
      intervalMs,
    });

    const results: Array<{
      index: number;
      success: boolean;
      rateLimited: boolean;
      timestamp: number;
    }> = [];

    const start = Date.now();
    let index = 0;

    while (Date.now() - start < durationSeconds * 1000 && index < totalTriggers) {
      const triggerStart = Date.now();

      try {
        await tasks.trigger<typeof noopTask>("noop-task", { index });
        results.push({
          index,
          success: true,
          rateLimited: false,
          timestamp: Date.now() - start,
        });
      } catch (error) {
        results.push({
          index,
          success: false,
          rateLimited: error instanceof RateLimitError,
          timestamp: Date.now() - start,
        });

        if (error instanceof RateLimitError) {
          logger.warn("Rate limit hit during sustained load", {
            index,
            timestamp: Date.now() - start,
            resetInMs: error.millisecondsUntilReset,
          });
        }
      }

      index++;

      // Maintain the target rate
      const elapsed = Date.now() - triggerStart;
      const sleepTime = Math.max(0, intervalMs - elapsed);
      if (sleepTime > 0) {
        await setTimeout(sleepTime);
      }
    }

    const duration = Date.now() - start;
    const successCount = results.filter((r) => r.success).length;
    const rateLimitedCount = results.filter((r) => r.rateLimited).length;

    // Find when rate limiting started (if at all)
    const firstRateLimited = results.find((r) => r.rateLimited);

    logger.info("Sustained load test completed", {
      actualDuration: duration,
      actualTriggers: results.length,
      successCount,
      rateLimitedCount,
      actualRate: Math.round((results.length / duration) * 1000),
    });

    return {
      config: {
        targetTriggersPerSecond: triggersPerSecond,
        targetDurationSeconds: durationSeconds,
      },
      results: {
        actualDuration: duration,
        actualTriggers: results.length,
        successCount,
        rateLimitedCount,
        actualRate: Math.round((results.length / duration) * 1000),
        hitRateLimit: rateLimitedCount > 0,
        firstRateLimitedAt: firstRateLimited
          ? {
              index: firstRateLimited.index,
              timestampMs: firstRateLimited.timestamp,
            }
          : null,
      },
    };
  },
});
