import {
  createRedisClient,
  Redis,
  RedisOptions,
  type Callback,
  type Result,
} from "@internal/redis";
import { startSpan } from "@internal/tracing";
import {
  parseNaturalLanguageDuration,
  parseNaturalLanguageDurationInMs,
} from "@trigger.dev/core/v3/isomorphic";
import {
  PrismaClientOrTransaction,
  PrismaReplicaClient,
  TaskRun,
  Waitpoint,
} from "@trigger.dev/database";
import { nanoid } from "nanoid";
import { SystemResources } from "./systems.js";
import { ExecutionSnapshotSystem, getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import { DelayedRunSystem } from "./delayedRunSystem.js";
import { LockAcquisitionTimeoutError } from "../locking.js";

export type DebounceOptions = {
  key: string;
  delay: string;
  mode?: "leading" | "trailing";
  /**
   * Maximum total delay before the run must execute, regardless of subsequent triggers.
   * This prevents indefinite delays when continuous triggers keep pushing the execution time.
   * If not specified, falls back to the server's maxDebounceDurationMs config.
   */
  maxDelay?: string;
  /** When mode: "trailing", these fields will be used to update the existing run */
  updateData?: {
    payload: string;
    payloadType: string;
    metadata?: string;
    metadataType?: string;
    tags?: string[];
    maxAttempts?: number;
    maxDurationInSeconds?: number;
    machine?: string;
  };
};

export type DebounceSystemOptions = {
  resources: SystemResources;
  redis: RedisOptions;
  executionSnapshotSystem: ExecutionSnapshotSystem;
  delayedRunSystem: DelayedRunSystem;
  maxDebounceDurationMs: number;
  /**
   * Bucket size in milliseconds used to quantize the newly computed `delayUntil`.
   * Set to 0 to disable quantization.
   */
  quantizeNewDelayUntilMs?: number;
  /**
   * When true, read the existing run's `delayUntil` outside the redlock and
   * short-circuit if the new (quantized) `delayUntil` is not later than the
   * current one.
   */
  fastPathSkipEnabled?: boolean;
  /**
   * When true, route the unlocked fast-path read through `readOnlyPrisma`
   * (e.g. an Aurora reader) instead of the writer.
   */
  useReplicaForFastPathRead?: boolean;
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
  private readonly quantizeNewDelayUntilMs: number;
  private readonly fastPathSkipEnabled: boolean;
  private readonly useReplicaForFastPathRead: boolean;

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
    this.quantizeNewDelayUntilMs = Math.max(0, options.quantizeNewDelayUntilMs ?? 1000);
    this.fastPathSkipEnabled = options.fastPathSkipEnabled ?? true;
    this.useReplicaForFastPathRead = options.useReplicaForFastPathRead ?? false;

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

    // Atomically sets runId only if current value equals expected pending claim.
    // This prevents the TOCTOU race condition where between GET (check claim) and SET (register),
    // another server could claim and register a different run, which would get overwritten.
    // Returns 1 if set succeeded, 0 if claim mismatch (lost the claim).
    this.redis.defineCommand("registerIfClaimOwned", {
      numberOfKeys: 1,
      lua: `
local value = redis.call('GET', KEYS[1])
if value == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0
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
   * Atomically claims the debounce key before returning "new".
   * This prevents the race condition where returning "new" without a claimId
   * allows registerDebouncedRun to do a plain SET that can overwrite another server's registration.
   *
   * This method is called when we've determined there's no valid existing run but need
   * to safely claim the key before creating a new one.
   */
  private async claimKeyForNewRun({
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
    const claimId = nanoid(16);

    const claimResult = await this.claimDebounceKey({
      environmentId,
      taskIdentifier,
      debounceKey: debounce.key,
      claimId,
      ttlMs: CLAIM_TTL_MS,
    });

    if (claimResult.claimed) {
      this.$.logger.debug("claimKeyForNewRun: claimed key, returning new", {
        debounceKey: debounce.key,
        taskIdentifier,
        environmentId,
        claimId,
      });
      return { status: "new", claimId };
    }

    if (claimResult.existingRunId) {
      // Another server registered a run while we were processing - handle it
      this.$.logger.debug("claimKeyForNewRun: found existing run, handling it", {
        debounceKey: debounce.key,
        existingRunId: claimResult.existingRunId,
      });
      return await this.handleExistingRun({
        existingRunId: claimResult.existingRunId,
        redisKey,
        environmentId,
        taskIdentifier,
        debounce,
        tx,
      });
    }

    // Another server is creating (pending state) - wait for it
    this.$.logger.debug("claimKeyForNewRun: key is pending, waiting for existing run", {
      debounceKey: debounce.key,
    });
    return await this.waitForExistingRun({
      environmentId,
      taskIdentifier,
      debounce,
      tx,
    });
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
        // Key expired or was deleted - atomically claim before returning "new"
        this.$.logger.debug("waitForExistingRun: key expired/deleted, claiming key", {
          redisKey,
          debounceKey: debounce.key,
          attempt: i + 1,
        });
        return await this.claimKeyForNewRun({
          environmentId,
          taskIdentifier,
          debounce,
          tx,
        });
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
          environmentId,
          taskIdentifier,
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
      // Key was pending (or didn't exist) - atomically claim before returning "new"
      this.$.logger.debug("waitForExistingRun: stale pending key deleted, claiming key", {
        redisKey,
        debounceKey: debounce.key,
      });
      return await this.claimKeyForNewRun({
        environmentId,
        taskIdentifier,
        debounce,
        tx,
      });
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
      environmentId,
      taskIdentifier,
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
    environmentId,
    taskIdentifier,
    debounce,
    tx,
  }: {
    existingRunId: string;
    redisKey: string;
    environmentId: string;
    taskIdentifier: string;
    debounce: DebounceOptions;
    tx?: PrismaClientOrTransaction;
  }): Promise<DebounceResult> {
    const prisma = tx ?? this.$.prisma;
    // Reads that are explicitly best-effort (the fast-path skip) can run on
    // `readOnlyPrisma` when configured. Replica lag is fine: the monotonic-
    // forward invariant means a stale read just falls through to the locked
    // path. Only divert reads when the caller isn't inside a tx (where the
    // read needs to see the tx's writes).
    const fastPathReadPrisma =
      tx ?? (this.useReplicaForFastPathRead ? this.$.readOnlyPrisma : this.$.prisma);

    // Compute the (quantized) target delayUntil up-front, before taking any lock.
    // Quantizing to e.g. 1s buckets collapses many concurrent triggers on the same
    // hot debounce key onto the same target time, so the unlocked fast-path skip
    // below becomes effective and the redlock is not contended.
    const newDelayUntil = this.#computeQuantizedDelayUntil(debounce.delay);

    // Fast-path: read the current delayUntil outside the redlock and short-circuit
    // if our (quantized) newDelayUntil isn't later than what's already scheduled.
    // Safe because debounce is monotonic-forward only: a stale read either matches
    // reality or undershoots, both of which decay correctly (re-checked properly
    // inside the lock by whoever is actually pushing forward).
    if (this.fastPathSkipEnabled && newDelayUntil) {
      const fastPathResult = await this.#tryFastPathSkip({
        existingRunId,
        newDelayUntil,
        debounce,
        prisma: fastPathReadPrisma,
      });
      if (fastPathResult) {
        return fastPathResult;
      }
    }

    try {
      return await this.$.runLock.lock("handleDebounce", [existingRunId], async () => {
        return await this.#handleExistingRunLocked({
          existingRunId,
          redisKey,
          environmentId,
          taskIdentifier,
          debounce,
          newDelayUntil,
          prisma,
          tx,
        });
      });
    } catch (error) {
      // Lock contention safety net: if we couldn't take the lock (redlock quorum
      // failure or our retry budget exhausted), fall in line with whoever is
      // actually updating the run instead of bubbling a 5xx to the SDK and
      // amplifying the herd via SDK retries. Debounce is best-effort - dropping
      // our contribution to delayUntil here is fine, the herd is updating it for
      // us.
      if (this.#isLockContentionError(error)) {
        return await this.#handleLockContentionFallback({
          existingRunId,
          debounce,
          error,
          prisma,
        });
      }
      throw error;
    }
  }

  /**
   * Parses the debounce delay and (optionally) quantizes it to a bucket boundary
   * by flooring the absolute timestamp. Quantization makes concurrent triggers on
   * the same key share a target time, which is what makes the unlocked fast-path
   * skip effective.
   */
  #computeQuantizedDelayUntil(delay: string): Date | null {
    const parsed = parseNaturalLanguageDuration(delay);
    if (!parsed) {
      return null;
    }
    if (this.quantizeNewDelayUntilMs <= 0) {
      return parsed;
    }
    const bucket = this.quantizeNewDelayUntilMs;
    const quantized = Math.floor(parsed.getTime() / bucket) * bucket;
    return new Date(quantized);
  }

  #isLockContentionError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return (
      error instanceof LockAcquisitionTimeoutError ||
      error.name === "LockAcquisitionTimeoutError" ||
      error.name === "ExecutionError" ||
      error.name === "ResourceLockedError"
    );
  }

  /**
   * Reads `delayUntil`/`status`/`createdAt` outside the redlock and
   * short-circuits if the existing scheduled time already covers our target.
   * Skips trailing-mode triggers that carry `updateData` since those still need
   * the lock to apply their data update. Also falls through when the run has
   * already exceeded its max debounce duration so the locked path can return
   * `max_duration_exceeded` and let the caller create a new run.
   */
  async #tryFastPathSkip({
    existingRunId,
    newDelayUntil,
    debounce,
    prisma,
  }: {
    existingRunId: string;
    newDelayUntil: Date;
    debounce: DebounceOptions;
    prisma: PrismaClientOrTransaction | PrismaReplicaClient;
  }): Promise<DebounceResult | null> {
    // Trailing mode with updateData still needs the lock so the data update is
    // applied; only short-circuit when there's nothing to update.
    if (debounce.mode === "trailing" && debounce.updateData) {
      return null;
    }

    const probe = await prisma.taskRun.findFirst({
      where: { id: existingRunId },
      select: { status: true, delayUntil: true, createdAt: true },
    });
    if (!probe || probe.status !== "DELAYED" || !probe.delayUntil) {
      return null;
    }
    if (newDelayUntil.getTime() > probe.delayUntil.getTime()) {
      return null;
    }

    // Fall through to the lock path when newDelayUntil would exceed the run's
    // max debounce window so the caller can return max_duration_exceeded and
    // create a fresh run.
    let maxDurationMs = this.maxDebounceDurationMs;
    if (debounce.maxDelay) {
      const parsedMaxDelay = parseNaturalLanguageDurationInMs(debounce.maxDelay);
      if (parsedMaxDelay !== undefined) {
        maxDurationMs = parsedMaxDelay;
      }
    }
    const maxDelayUntilMs = probe.createdAt.getTime() + maxDurationMs;
    if (newDelayUntil.getTime() > maxDelayUntilMs) {
      return null;
    }

    const fullRun = await prisma.taskRun.findFirst({
      where: { id: existingRunId },
      include: { associatedWaitpoint: true },
    });
    if (!fullRun || fullRun.status !== "DELAYED") {
      return null;
    }

    this.$.logger.debug("handleExistingRun: fast-path skip, existing delayUntil already covers", {
      existingRunId,
      debounceKey: debounce.key,
      newDelayUntil,
      currentDelayUntil: fullRun.delayUntil,
    });

    return {
      status: "existing",
      run: fullRun,
      waitpoint: fullRun.associatedWaitpoint,
    };
  }

  async #handleLockContentionFallback({
    existingRunId,
    debounce,
    error,
    prisma,
  }: {
    existingRunId: string;
    debounce: DebounceOptions;
    error: unknown;
    prisma: PrismaClientOrTransaction;
  }): Promise<DebounceResult> {
    const fullRun = await prisma.taskRun.findFirst({
      where: { id: existingRunId },
      include: { associatedWaitpoint: true },
    });

    if (!fullRun || fullRun.status !== "DELAYED") {
      // The run is no longer in a state we can safely return as "existing" -
      // re-throw so the caller surfaces the failure rather than silently
      // succeeding on a stale/terminated run.
      this.$.logger.warn(
        "handleExistingRun: lock contention, but existing run no longer DELAYED - rethrowing",
        {
          existingRunId,
          debounceKey: debounce.key,
          status: fullRun?.status,
        }
      );
      throw error;
    }

    if (debounce.mode === "trailing" && debounce.updateData) {
      // Trailing-mode triggers carrying updateData are user-visible: dropping
      // them silently would mean the eventual run executes against stale
      // payload/metadata/tags. Surface the lock failure instead so the SDK can
      // retry and (with the fast-path + quantization in place) the herd
      // collapses on its own without us hiding data loss.
      this.$.logger.warn(
        "handleExistingRun: lock contention with trailing updateData - rethrowing to avoid silently dropping update",
        {
          existingRunId,
          debounceKey: debounce.key,
        }
      );
      throw error;
    }

    this.$.logger.warn(
      "handleExistingRun: lock contention, returning existing run without rescheduling",
      {
        existingRunId,
        debounceKey: debounce.key,
        currentDelayUntil: fullRun.delayUntil,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
      }
    );

    return {
      status: "existing",
      run: fullRun,
      waitpoint: fullRun.associatedWaitpoint,
    };
  }

  /**
   * Body of `handleExistingRun` that runs while holding the redlock on the run.
   * Receives the (possibly quantized) `newDelayUntil` precomputed by the caller.
   */
  async #handleExistingRunLocked({
    existingRunId,
    redisKey,
    environmentId,
    taskIdentifier,
    debounce,
    newDelayUntil,
    prisma,
    tx,
  }: {
    existingRunId: string;
    redisKey: string;
    environmentId: string;
    taskIdentifier: string;
    debounce: DebounceOptions;
    newDelayUntil: Date | null;
    prisma: PrismaClientOrTransaction;
    tx?: PrismaClientOrTransaction;
  }): Promise<DebounceResult> {
    {
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
        // Clean up stale Redis key and atomically claim before returning "new"
        await this.redis.del(redisKey);
        return await this.claimKeyForNewRun({
          environmentId,
          taskIdentifier,
          debounce,
          tx,
        });
      }

      // Check if run is still in DELAYED status (or legacy RUN_CREATED for older runs)
      if (snapshot.executionStatus !== "DELAYED" && snapshot.executionStatus !== "RUN_CREATED") {
        this.$.logger.debug("handleExistingRun: existing run is no longer delayed", {
          existingRunId,
          executionStatus: snapshot.executionStatus,
          debounceKey: debounce.key,
        });
        // Clean up Redis key and atomically claim before returning "new"
        await this.redis.del(redisKey);
        return await this.claimKeyForNewRun({
          environmentId,
          taskIdentifier,
          debounce,
          tx,
        });
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
        // Clean up stale Redis key and atomically claim before returning "new"
        await this.redis.del(redisKey);
        return await this.claimKeyForNewRun({
          environmentId,
          taskIdentifier,
          debounce,
          tx,
        });
      }

      if (!newDelayUntil) {
        this.$.logger.error("handleExistingRun: invalid delay duration", {
          delay: debounce.delay,
        });
        // Invalid delay but we still need to atomically claim before returning "new"
        return await this.claimKeyForNewRun({
          environmentId,
          taskIdentifier,
          debounce,
          tx,
        });
      }

      // Check if max debounce duration would be exceeded
      // Use per-trigger maxDelay if provided, otherwise use global config
      let maxDurationMs = this.maxDebounceDurationMs;
      if (debounce.maxDelay) {
        const parsedMaxDelay = parseNaturalLanguageDurationInMs(debounce.maxDelay);
        if (parsedMaxDelay !== undefined) {
          maxDurationMs = parsedMaxDelay;
        } else {
          this.$.logger.warn("handleExistingRun: invalid maxDelay duration, using global config", {
            maxDelay: debounce.maxDelay,
            fallbackMs: this.maxDebounceDurationMs,
          });
        }
      }

      const runCreatedAt = existingRun.createdAt;
      const maxDelayUntil = new Date(runCreatedAt.getTime() + maxDurationMs);

      if (newDelayUntil > maxDelayUntil) {
        this.$.logger.debug("handleExistingRun: max debounce duration would be exceeded", {
          existingRunId,
          debounceKey: debounce.key,
          runCreatedAt,
          newDelayUntil,
          maxDelayUntil,
          maxDurationMs,
          maxDelayProvided: debounce.maxDelay,
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

      // Update run data when mode is "trailing"
      let updatedRun = existingRun;
      if (debounce.mode === "trailing" && debounce.updateData) {
        updatedRun = await this.#updateRunForTrailingMode({
          runId: existingRunId,
          updateData: debounce.updateData,
          tx: prisma,
        });

        this.$.logger.debug("handleExistingRun: updated run data for trailing mode", {
          existingRunId,
          debounceKey: debounce.key,
        });
      }

      return {
        status: "existing",
        run: updatedRun,
        waitpoint: existingRun.associatedWaitpoint,
      };
    }
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
          environmentId,
          taskIdentifier,
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

        // Calculate TTL: delay until + buffer
        const ttlMs = Math.max(
          delayUntil.getTime() - Date.now() + 60_000, // Add 1 minute buffer
          60_000
        );

        if (claimId) {
          // Use atomic Lua script to verify claim and set runId in one operation.
          // This prevents the TOCTOU race where another server could claim and register
          // between our GET check and SET.
          const result = await this.redis.registerIfClaimOwned(
            redisKey,
            `pending:${claimId}`,
            runId,
            ttlMs.toString()
          );

          if (result === 0) {
            // We lost the claim - another server took over or it expired
            this.$.logger.warn("registerDebouncedRun: lost claim, not registering", {
              runId,
              environmentId,
              taskIdentifier,
              debounceKey,
              claimId,
            });
            span.setAttribute("claimLost", true);
            return false;
          }
        } else {
          // No claim to verify, just set directly
          await this.redis.set(redisKey, runId, "PX", ttlMs);
        }

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

  /**
   * Updates a run's data for trailing mode debounce.
   * Updates: payload, metadata, tags, maxAttempts, maxDurationInSeconds, machinePreset
   */
  async #updateRunForTrailingMode({
    runId,
    updateData,
    tx,
  }: {
    runId: string;
    updateData: NonNullable<DebounceOptions["updateData"]>;
    tx?: PrismaClientOrTransaction;
  }): Promise<TaskRun & { associatedWaitpoint: Waitpoint | null }> {
    const prisma = tx ?? this.$.prisma;

    // Build the update object
    const updatePayload: {
      payload: string;
      payloadType: string;
      metadata?: string;
      metadataType?: string;
      maxAttempts?: number;
      maxDurationInSeconds?: number;
      machinePreset?: string;
      runTags?: string[];
      tags?: {
        set: { id: string }[];
      };
    } = {
      payload: updateData.payload,
      payloadType: updateData.payloadType,
    };

    if (updateData.metadata !== undefined) {
      updatePayload.metadata = updateData.metadata;
      updatePayload.metadataType = updateData.metadataType ?? "application/json";
    }

    if (updateData.maxAttempts !== undefined) {
      updatePayload.maxAttempts = updateData.maxAttempts;
    }

    if (updateData.maxDurationInSeconds !== undefined) {
      updatePayload.maxDurationInSeconds = updateData.maxDurationInSeconds;
    }

    if (updateData.machine !== undefined) {
      updatePayload.machinePreset = updateData.machine;
    }

    // Handle tags update - replace existing tags
    if (updateData.tags !== undefined) {
      updatePayload.runTags = updateData.tags;
    }

    const updatedRun = await prisma.taskRun.update({
      where: { id: runId },
      data: updatePayload,
      include: {
        associatedWaitpoint: true,
      },
    });

    return updatedRun;
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

    /**
     * Atomically sets runId only if current value equals expected pending claim.
     * Prevents TOCTOU race condition between claim verification and registration.
     * @param key - The Redis key
     * @param expectedClaim - Expected value "pending:{claimId}"
     * @param runId - The new value (run ID) to set
     * @param ttlMs - TTL in milliseconds
     * @returns 1 if set succeeded, 0 if claim mismatch
     */
    registerIfClaimOwned(
      key: string,
      expectedClaim: string,
      runId: string,
      ttlMs: string,
      callback?: Callback<number>
    ): Result<number, Context>;
  }
}
