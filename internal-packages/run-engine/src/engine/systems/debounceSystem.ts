import {
  createRedisClient,
  Redis,
  RedisOptions,
  type Callback,
  type Result,
} from "@internal/redis";
import { startSpan } from "@internal/tracing";
import { parseNaturalLanguageDuration } from "@trigger.dev/core/v3/isomorphic";
import { PrismaClientOrTransaction, TaskRun, Waitpoint } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import { SystemResources } from "./systems.js";
import { ExecutionSnapshotSystem, getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import { DelayedRunSystem } from "./delayedRunSystem.js";

export type DebounceOptions = {
  key: string;
  delay: string;
};

export type DebounceSystemOptions = {
  resources: SystemResources;
  redis: RedisOptions;
  executionSnapshotSystem: ExecutionSnapshotSystem;
  delayedRunSystem: DelayedRunSystem;
  maxDebounceDurationMs: number;
};

export type DebounceResult =
  | {
      status: "new";
      claimId?: string; // Present when we claimed the key atomically
    }
  | {
      status: "existing";
      run: TaskRun;
      waitpoint: Waitpoint | null;
    }
  | {
      status: "max_duration_exceeded";
    };

// TTL for the pending claim state (30 seconds)
const CLAIM_TTL_MS = 30_000;
// Max retries when waiting for another server to complete its claim
const MAX_CLAIM_RETRIES = 10;
// Delay between retries when waiting for pending claim
const CLAIM_RETRY_DELAY_MS = 50;

export type DebounceData = {
  key: string;
  delay: string;
  createdAt: Date;
};

/**
 * DebounceSystem handles debouncing of task triggers.
 *
 * When a run is triggered with a debounce key, if an existing run with the same key
 * is still in the DELAYED execution status, the new trigger "pushes" the existing
 * run's execution time later rather than creating a new run.
 *
 * The debounce key mapping is stored in Redis for fast lookups (to avoid database indexes).
 */
export class DebounceSystem {
  private readonly $: SystemResources;
  private readonly redis: Redis;
  private readonly executionSnapshotSystem: ExecutionSnapshotSystem;
  private readonly delayedRunSystem: DelayedRunSystem;
  private readonly maxDebounceDurationMs: number;

  constructor(options: DebounceSystemOptions) {
    this.$ = options.resources;
    this.redis = createRedisClient(
      {
        ...options.redis,
        keyPrefix: `${options.redis.keyPrefix ?? ""}debounce:`,
      },
      {
        onError: (error) => {
          this.$.logger.error("DebounceSystem redis client error:", { error });
        },
      }
    );
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.delayedRunSystem = options.delayedRunSystem;
    this.maxDebounceDurationMs = options.maxDebounceDurationMs;

    this.#registerCommands();
  }

  #registerCommands() {
    // Atomically deletes a key only if its value starts with "pending:".
    // Returns [1, nil] if deleted (was pending or didn't exist)
    // Returns [0, value] if not deleted (has a run ID)
    // This prevents the race condition where between checking "still pending?"
    // and calling DEL, the original server could complete and register a valid run ID.
    this.redis.defineCommand("conditionallyDeletePendingKey", {
      numberOfKeys: 1,
      lua: `
local value = redis.call('GET', KEYS[1])
if not value then
  return { 1, nil }
end
if string.sub(value, 1, 8) == 'pending:' then
  redis.call('DEL', KEYS[1])
  return { 1, nil }
end
return { 0, value }
      `,
    });
  }

  /**
   * Gets the Redis key for a debounce lookup.
   * Key pattern: {envId}:{taskId}:{debounceKey}
   */
  private getDebounceRedisKey(envId: string, taskId: string, debounceKey: string): string {
    return `${envId}:${taskId}:${debounceKey}`;
  }

  /**
   * Atomically deletes a key only if its value still starts with "pending:".
   * This prevents the race condition where between the final GET check and DEL,
   * the original server could complete and register a valid run ID.
   *
   * @returns { deleted: true } if the key was deleted or didn't exist
   * @returns { deleted: false, existingRunId: string } if the key has a valid run ID
   */
  private async conditionallyDeletePendingKey(
    redisKey: string
  ): Promise<{ deleted: true } | { deleted: false; existingRunId: string }> {
    const result = await this.redis.conditionallyDeletePendingKey(redisKey);

    if (!result) {
      // Should not happen, but treat as deleted if no result
      return { deleted: true };
    }

    const [wasDeleted, currentValue] = result;

    if (wasDeleted === 1) {
      return { deleted: true };
    }

    // Key exists with a valid run ID
    return { deleted: false, existingRunId: currentValue! };
  }

  /**
   * Atomically claims a debounce key using SET NX.
   * This prevents the race condition where two servers both check for an existing
   * run, find none, and both create new runs.
   *
   * Returns:
   * - { claimed: true } if we successfully claimed the key
   * - { claimed: false, existingRunId: string } if key exists with a run ID
   * - { claimed: false, existingRunId: null } if key exists but is pending (another server is creating)
   */
  private async claimDebounceKey({
    environmentId,
    taskIdentifier,
    debounceKey,
    claimId,
    ttlMs,
  }: {
    environmentId: string;
    taskIdentifier: string;
    debounceKey: string;
    claimId: string;
    ttlMs: number;
  }): Promise<{ claimed: true } | { claimed: false; existingRunId: string | null }> {
    const redisKey = this.getDebounceRedisKey(environmentId, taskIdentifier, debounceKey);

    // Try to claim with SET NX (only succeeds if key doesn't exist)
    const result = await this.redis.set(redisKey, `pending:${claimId}`, "PX", ttlMs, "NX");

    if (result === "OK") {
      this.$.logger.debug("claimDebounceKey: claimed key", {
        redisKey,
        claimId,
        debounceKey,
      });
      return { claimed: true };
    }

    // Claim failed - get existing value
    const existingValue = await this.redis.get(redisKey);

    if (!existingValue) {
      // Key expired between SET and GET - rare race, return null to trigger retry
      this.$.logger.debug("claimDebounceKey: key expired between SET and GET", {
        redisKey,
        debounceKey,
      });
      return { claimed: false, existingRunId: null };
    }

    if (existingValue.startsWith("pending:")) {
      // Another server is creating the run - return null to trigger wait/retry
      this.$.logger.debug("claimDebounceKey: key is pending (another server is creating)", {
        redisKey,
        debounceKey,
        existingValue,
      });
      return { claimed: false, existingRunId: null };
    }

    // It's a run ID
    this.$.logger.debug("claimDebounceKey: found existing run", {
      redisKey,
      debounceKey,
      existingRunId: existingValue,
    });
    return { claimed: false, existingRunId: existingValue };
  }

  /**
   * Waits for another server to complete its claim and register a run ID.
   * Used when we detect a "pending" state, meaning another server has claimed
   * the key but hasn't yet created the run.
   */
  private async waitForExistingRun({
    environmentId,
    taskIdentifier,
    debounce,
    tx,
  }: {
    environmentId: string;
    taskIdentifier: string;
    debounce: DebounceOptions;
    tx?: PrismaClientOrTransaction;
  }): Promise<DebounceResult> {
    const redisKey = this.getDebounceRedisKey(environmentId, taskIdentifier, debounce.key);

    for (let i = 0; i < MAX_CLAIM_RETRIES; i++) {
      await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_DELAY_MS));

      const value = await this.redis.get(redisKey);

      if (!value) {
        // Key expired or was deleted - return "new" to create fresh
        this.$.logger.debug("waitForExistingRun: key expired/deleted, returning new", {
          redisKey,
          debounceKey: debounce.key,
          attempt: i + 1,
        });
        return { status: "new" };
      }

      if (!value.startsWith("pending:")) {
        // It's a run ID now - proceed with reschedule logic
        this.$.logger.debug("waitForExistingRun: found run ID, handling existing run", {
          redisKey,
          debounceKey: debounce.key,
          existingRunId: value,
          attempt: i + 1,
        });
        return await this.handleExistingRun({
          existingRunId: value,
          redisKey,
          debounce,
          tx,
        });
      }

      this.$.logger.debug("waitForExistingRun: still pending, retrying", {
        redisKey,
        debounceKey: debounce.key,
        attempt: i + 1,
        value,
      });
    }

    // Timed out waiting - the other server may have failed
    // Conditionally delete the key only if it's still pending
    // This prevents the race where the original server completed between our last check and now
    this.$.logger.warn(
      "waitForExistingRun: timed out waiting for pending claim, attempting conditional delete",
      {
        redisKey,
        debounceKey: debounce.key,
      }
    );

    const deleteResult = await this.conditionallyDeletePendingKey(redisKey);

    if (deleteResult.deleted) {
      // Key was pending (or didn't exist) - safe to create new run
      this.$.logger.debug("waitForExistingRun: stale pending key deleted, returning new", {
        redisKey,
        debounceKey: debounce.key,
      });
      return { status: "new" };
    }

    // Key now has a valid run ID - the original server completed!
    // Handle the existing run instead of creating a duplicate
    this.$.logger.debug(
      "waitForExistingRun: original server completed during timeout, handling existing run",
      {
        redisKey,
        debounceKey: debounce.key,
        existingRunId: deleteResult.existingRunId,
      }
    );
    return await this.handleExistingRun({
      existingRunId: deleteResult.existingRunId,
      redisKey,
      debounce,
      tx,
    });
  }

  /**
   * Handles an existing debounced run by locking it and rescheduling.
   * Extracted to be reusable by both handleDebounce and waitForExistingRun.
   */
  private async handleExistingRun({
    existingRunId,
    redisKey,
    debounce,
    tx,
  }: {
    existingRunId: string;
    redisKey: string;
    debounce: DebounceOptions;
    tx?: PrismaClientOrTransaction;
  }): Promise<DebounceResult> {
    return await this.$.runLock.lock("handleDebounce", [existingRunId], async () => {
      const prisma = tx ?? this.$.prisma;

      // Get the latest execution snapshot
      let snapshot;
      try {
        snapshot = await getLatestExecutionSnapshot(prisma, existingRunId);
      } catch (error) {
        // Run no longer exists or has no snapshot
        this.$.logger.debug("handleExistingRun: existing run not found or has no snapshot", {
          existingRunId,
          debounceKey: debounce.key,
          error,
        });
        // Clean up stale Redis key
        await this.redis.del(redisKey);
        return { status: "new" };
      }

      // Check if run is still in DELAYED status (or legacy RUN_CREATED for older runs)
      if (snapshot.executionStatus !== "DELAYED" && snapshot.executionStatus !== "RUN_CREATED") {
        this.$.logger.debug("handleExistingRun: existing run is no longer delayed", {
          existingRunId,
          executionStatus: snapshot.executionStatus,
          debounceKey: debounce.key,
        });
        // Clean up Redis key since run is no longer debounceable
        await this.redis.del(redisKey);
        return { status: "new" };
      }

      // Get the run to check debounce metadata and createdAt
      const existingRun = await prisma.taskRun.findFirst({
        where: { id: existingRunId },
        include: {
          associatedWaitpoint: true,
        },
      });

      if (!existingRun) {
        this.$.logger.debug("handleExistingRun: existing run not found in database", {
          existingRunId,
          debounceKey: debounce.key,
        });
        await this.redis.del(redisKey);
        return { status: "new" };
      }

      // Calculate new delay - parseNaturalLanguageDuration returns a Date (now + duration)
      const newDelayUntil = parseNaturalLanguageDuration(debounce.delay);
      if (!newDelayUntil) {
        this.$.logger.error("handleExistingRun: invalid delay duration", {
          delay: debounce.delay,
        });
        return { status: "new" };
      }

      // Check if max debounce duration would be exceeded
      const runCreatedAt = existingRun.createdAt;
      const maxDelayUntil = new Date(runCreatedAt.getTime() + this.maxDebounceDurationMs);

      if (newDelayUntil > maxDelayUntil) {
        this.$.logger.debug("handleExistingRun: max debounce duration would be exceeded", {
          existingRunId,
          debounceKey: debounce.key,
          runCreatedAt,
          newDelayUntil,
          maxDelayUntil,
          maxDebounceDurationMs: this.maxDebounceDurationMs,
        });
        // Clean up Redis key since this debounce window is closed
        await this.redis.del(redisKey);
        return { status: "max_duration_exceeded" };
      }

      // Only reschedule if the new delay would push the run later
      // This ensures debounce always "pushes later", never earlier
      const currentDelayUntil = existingRun.delayUntil;
      const shouldReschedule = !currentDelayUntil || newDelayUntil > currentDelayUntil;

      if (shouldReschedule) {
        // Reschedule the delayed run
        await this.delayedRunSystem.rescheduleDelayedRun({
          runId: existingRunId,
          delayUntil: newDelayUntil,
          tx: prisma,
        });

        // Update Redis TTL
        const ttlMs = Math.max(
          newDelayUntil.getTime() - Date.now() + 60_000, // Add 1 minute buffer
          60_000
        );
        await this.redis.pexpire(redisKey, ttlMs);

        this.$.logger.debug("handleExistingRun: rescheduled existing debounced run", {
          existingRunId,
          debounceKey: debounce.key,
          newDelayUntil,
        });
      } else {
        this.$.logger.debug(
          "handleExistingRun: skipping reschedule, new delay is not later than current",
          {
            existingRunId,
            debounceKey: debounce.key,
            currentDelayUntil,
            newDelayUntil,
          }
        );
      }

      return {
        status: "existing",
        run: existingRun,
        waitpoint: existingRun.associatedWaitpoint,
      };
    });
  }

  /**
   * Called during trigger to check for an existing debounced run.
   * If found and still in DELAYED status, reschedules it and returns the existing run.
   *
   * Uses atomic SET NX to prevent the distributed race condition where two servers
   * both check for an existing run, find none, and both create new runs.
   *
   * Note: This method does NOT handle blocking parent runs for triggerAndWait.
   * The caller (RunEngine.trigger) is responsible for blocking using waitpointSystem.blockRunWithWaitpoint().
   */
  async handleDebounce({
    environmentId,
    taskIdentifier,
    debounce,
    tx,
  }: {
    environmentId: string;
    taskIdentifier: string;
    debounce: DebounceOptions;
    tx?: PrismaClientOrTransaction;
  }): Promise<DebounceResult> {
    return startSpan(
      this.$.tracer,
      "handleDebounce",
      async (span) => {
        span.setAttribute("debounceKey", debounce.key);
        span.setAttribute("taskIdentifier", taskIdentifier);
        span.setAttribute("environmentId", environmentId);

        const redisKey = this.getDebounceRedisKey(environmentId, taskIdentifier, debounce.key);
        const claimId = nanoid(16); // Unique ID for this claim attempt

        // Try to atomically claim the debounce key
        const claimResult = await this.claimDebounceKey({
          environmentId,
          taskIdentifier,
          debounceKey: debounce.key,
          claimId,
          ttlMs: CLAIM_TTL_MS,
        });

        if (claimResult.claimed) {
          // We successfully claimed the key - return "new" to create the run
          // Caller will call registerDebouncedRun after creating the run
          this.$.logger.debug("handleDebounce: claimed key, returning new", {
            debounceKey: debounce.key,
            taskIdentifier,
            environmentId,
            claimId,
          });
          span.setAttribute("claimed", true);
          span.setAttribute("claimId", claimId);
          return { status: "new", claimId };
        }

        if (!claimResult.existingRunId) {
          // Another server is creating - wait and retry to get the run ID
          this.$.logger.debug("handleDebounce: key is pending, waiting for existing run", {
            debounceKey: debounce.key,
            taskIdentifier,
            environmentId,
          });
          span.setAttribute("waitingForPending", true);
          return await this.waitForExistingRun({
            environmentId,
            taskIdentifier,
            debounce,
            tx,
          });
        }

        // Found existing run - lock and reschedule
        span.setAttribute("existingRunId", claimResult.existingRunId);
        return await this.handleExistingRun({
          existingRunId: claimResult.existingRunId,
          redisKey,
          debounce,
          tx,
        });
      },
      {
        attributes: {
          environmentId,
          taskIdentifier,
          debounceKey: debounce.key,
        },
      }
    );
  }

  /**
   * Stores the debounce key -> runId mapping after creating a new debounced run.
   *
   * If claimId is provided, verifies we still own the pending claim before registering.
   * This prevents a race where our claim expired and another server took over.
   *
   * @returns true if registration succeeded, false if we lost the claim
   */
  async registerDebouncedRun({
    runId,
    environmentId,
    taskIdentifier,
    debounceKey,
    delayUntil,
    claimId,
  }: {
    runId: string;
    environmentId: string;
    taskIdentifier: string;
    debounceKey: string;
    delayUntil: Date;
    claimId?: string;
  }): Promise<boolean> {
    return startSpan(
      this.$.tracer,
      "registerDebouncedRun",
      async (span) => {
        const redisKey = this.getDebounceRedisKey(environmentId, taskIdentifier, debounceKey);

        if (claimId) {
          // Verify we still own the pending claim before overwriting
          const currentValue = await this.redis.get(redisKey);
          if (currentValue !== `pending:${claimId}`) {
            // We lost the claim - another server took over or it expired
            this.$.logger.warn("registerDebouncedRun: lost claim, not registering", {
              runId,
              environmentId,
              taskIdentifier,
              debounceKey,
              claimId,
              currentValue,
            });
            span.setAttribute("claimLost", true);
            return false;
          }
        }

        // Calculate TTL: delay until + buffer
        const ttlMs = Math.max(
          delayUntil.getTime() - Date.now() + 60_000, // Add 1 minute buffer
          60_000
        );

        await this.redis.set(redisKey, runId, "PX", ttlMs);

        this.$.logger.debug("registerDebouncedRun: stored debounce key mapping", {
          runId,
          environmentId,
          taskIdentifier,
          debounceKey,
          delayUntil,
          ttlMs,
          claimId,
        });

        span.setAttribute("registered", true);
        return true;
      },
      {
        attributes: {
          runId,
          environmentId,
          taskIdentifier,
          debounceKey,
          claimId: claimId ?? "none",
        },
      }
    );
  }

  /**
   * Clears the debounce key when a run is enqueued or completed.
   */
  async clearDebounceKey({
    environmentId,
    taskIdentifier,
    debounceKey,
  }: {
    environmentId: string;
    taskIdentifier: string;
    debounceKey: string;
  }): Promise<void> {
    const redisKey = this.getDebounceRedisKey(environmentId, taskIdentifier, debounceKey);
    await this.redis.del(redisKey);

    this.$.logger.debug("clearDebounceKey: cleared debounce key mapping", {
      environmentId,
      taskIdentifier,
      debounceKey,
    });
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}

declare module "@internal/redis" {
  interface RedisCommander<Context> {
    /**
     * Atomically deletes a key only if its value starts with "pending:".
     * @returns [1, nil] if deleted (was pending or didn't exist)
     * @returns [0, value] if not deleted (has a run ID)
     */
    conditionallyDeletePendingKey(
      key: string,
      callback?: Callback<[number, string | null]>
    ): Result<[number, string | null], Context>;
  }
}
