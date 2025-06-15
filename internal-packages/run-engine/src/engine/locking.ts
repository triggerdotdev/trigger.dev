// import { default: Redlock } from "redlock";
const { default: Redlock } = require("redlock");
import { AsyncLocalStorage } from "async_hooks";
import { Redis } from "@internal/redis";
import * as redlock from "redlock";
import { tryCatch } from "@trigger.dev/core";
import { Logger } from "@trigger.dev/core/logger";
import {
  startSpan,
  Tracer,
  Meter,
  getMeter,
  ValueType,
  ObservableResult,
  Attributes,
  Histogram,
} from "@internal/tracing";

const SemanticAttributes = {
  LOCK_TYPE: "run_engine.lock.type",
  LOCK_RESOURCES: "run_engine.lock.resources",
  LOCK_SUCCESS: "run_engine.lock.success",
};

export class LockAcquisitionTimeoutError extends Error {
  constructor(
    public readonly resources: string[],
    public readonly totalWaitTime: number,
    public readonly attempts: number,
    message?: string
  ) {
    super(
      message ||
        `Failed to acquire lock on resources [${resources.join(
          ", "
        )}] after ${totalWaitTime}ms and ${attempts} attempts`
    );
    this.name = "LockAcquisitionTimeoutError";
  }
}

interface LockContext {
  resources: string;
  signal: redlock.RedlockAbortSignal;
  lockType: string;
}

interface ManualLockContext {
  lock: redlock.Lock;
  timeout: NodeJS.Timeout | null | undefined;
  extension: Promise<void> | undefined;
}

export interface LockRetryConfig {
  /** Maximum number of locking attempts (default: 10) */
  maxAttempts?: number;
  /** Initial delay in milliseconds (default: 200) */
  baseDelay?: number;
  /** Maximum delay cap in milliseconds (default: 5000) */
  maxDelay?: number;
  /** Exponential backoff multiplier (default: 1.5) */
  backoffMultiplier?: number;
  /** Jitter factor as percentage (default: 0.1 for 10%) */
  jitterFactor?: number;
  /** Maximum total wait time in milliseconds (default: 30000) */
  maxTotalWaitTime?: number;
}

export class RunLocker {
  private redlock: InstanceType<typeof redlock.default>;
  private asyncLocalStorage: AsyncLocalStorage<LockContext>;
  private logger: Logger;
  private tracer: Tracer;
  private meter: Meter;
  private activeLocks: Map<string, { lockType: string; resources: string[] }> = new Map();
  private activeManualContexts: Map<string, ManualLockContext> = new Map();
  private lockDurationHistogram: Histogram;
  private retryConfig: Required<LockRetryConfig>;
  private duration: number;
  private automaticExtensionThreshold: number;

  constructor(options: {
    redis: Redis;
    logger: Logger;
    tracer: Tracer;
    meter?: Meter;
    duration?: number;
    automaticExtensionThreshold?: number;
    retryConfig?: LockRetryConfig;
  }) {
    // Initialize configuration values
    this.duration = options.duration ?? 5000;
    this.automaticExtensionThreshold = options.automaticExtensionThreshold ?? 500;

    this.redlock = new Redlock([options.redis], {
      retryCount: 0, // Disable Redlock's internal retrying - we handle retries ourselves
    });
    this.asyncLocalStorage = new AsyncLocalStorage<LockContext>();
    this.logger = options.logger;
    this.tracer = options.tracer;
    this.meter = options.meter ?? getMeter("run-engine");

    // Initialize retry configuration with defaults
    this.retryConfig = {
      maxAttempts: options.retryConfig?.maxAttempts ?? 10,
      baseDelay: options.retryConfig?.baseDelay ?? 200,
      maxDelay: options.retryConfig?.maxDelay ?? 5000,
      backoffMultiplier: options.retryConfig?.backoffMultiplier ?? 1.5,
      jitterFactor: options.retryConfig?.jitterFactor ?? 0.1,
      maxTotalWaitTime: options.retryConfig?.maxTotalWaitTime ?? 30000,
    };

    const activeLocksObservableGauge = this.meter.createObservableGauge("run_engine.locks.active", {
      description: "The number of active locks by type",
      unit: "locks",
      valueType: ValueType.INT,
    });

    const lockDurationHistogram = this.meter.createHistogram("run_engine.lock.duration", {
      description: "The duration of lock operations",
      unit: "ms",
      valueType: ValueType.DOUBLE,
    });

    activeLocksObservableGauge.addCallback(this.#updateActiveLocksCount.bind(this));
    this.lockDurationHistogram = lockDurationHistogram;
  }

  async #updateActiveLocksCount(observableResult: ObservableResult<Attributes>) {
    // Group active locks by type
    const lockCountsByType = new Map<string, number>();

    for (const [_, lockInfo] of this.activeLocks) {
      const count = lockCountsByType.get(lockInfo.lockType) || 0;
      lockCountsByType.set(lockInfo.lockType, count + 1);
    }

    // Report metrics for each lock type
    for (const [lockType, count] of lockCountsByType) {
      observableResult.observe(count, {
        [SemanticAttributes.LOCK_TYPE]: lockType,
      });
    }
  }

  /** Locks resources using RedLock. It won't lock again if we're already inside a lock with the same resources. */
  async lock<T>(name: string, resources: string[], routine: () => Promise<T>): Promise<T> {
    const currentContext = this.asyncLocalStorage.getStore();
    const joinedResources = [...resources].sort().join(",");

    return startSpan(
      this.tracer,
      "RunLocker.lock",
      async (span) => {
        if (currentContext && currentContext.resources === joinedResources) {
          span.setAttribute("nested", true);
          // We're already inside a lock with the same resources, just run the routine
          return routine();
        }

        span.setAttribute("nested", false);

        // Different resources or not in a lock, proceed with new lock
        const lockId = `${name}:${joinedResources}:${Date.now()}`;
        const lockStartTime = performance.now();

        const [error, result] = await tryCatch(
          this.#acquireAndExecute(name, resources, this.duration, routine, lockId, lockStartTime)
        );

        if (error) {
          // Record failed lock acquisition
          const lockDuration = performance.now() - lockStartTime;
          this.lockDurationHistogram.record(lockDuration, {
            [SemanticAttributes.LOCK_TYPE]: name,
            [SemanticAttributes.LOCK_SUCCESS]: "false",
          });

          this.logger.error("[RunLocker] Error locking resources", {
            error,
            resources,
            duration: this.duration,
          });
          throw error;
        }

        return result;
      },
      {
        attributes: { name, resources, timeout: this.duration },
      }
    );
  }

  /** Manual lock acquisition with exponential backoff retry logic */
  async #acquireAndExecute<T>(
    name: string,
    resources: string[],
    duration: number,
    routine: () => Promise<T>,
    lockId: string,
    lockStartTime: number
  ): Promise<T> {
    // Sort resources to ensure consistent lock acquisition order and prevent deadlocks
    const sortedResources = [...resources].sort();
    const joinedResources = sortedResources.join(",");

    // Use configured retry settings with exponential backoff
    const { maxAttempts, baseDelay, maxDelay, backoffMultiplier, jitterFactor, maxTotalWaitTime } =
      this.retryConfig;

    // Track timing for total wait time limit
    let totalWaitTime = 0;

    // Retry the lock acquisition with exponential backoff
    let lock: redlock.Lock | undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const [error, acquiredLock] = await tryCatch(this.redlock.acquire(sortedResources, duration));

      if (!error && acquiredLock) {
        lock = acquiredLock;
        if (attempt > 0) {
          this.logger.debug("[RunLocker] Lock acquired after retries", {
            name,
            resources: sortedResources,
            attempts: attempt + 1,
            totalWaitTime: Math.round(totalWaitTime),
          });
        }
        break;
      }

      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we've exceeded total wait time limit
      if (totalWaitTime >= maxTotalWaitTime) {
        this.logger.warn("[RunLocker] Lock acquisition exceeded total wait time limit", {
          name,
          resources: sortedResources,
          attempts: attempt + 1,
          totalWaitTime: Math.round(totalWaitTime),
          maxTotalWaitTime,
        });
        throw new LockAcquisitionTimeoutError(
          sortedResources,
          Math.round(totalWaitTime),
          attempt + 1,
          `Lock acquisition on resources [${sortedResources.join(
            ", "
          )}] exceeded total wait time limit of ${maxTotalWaitTime}ms`
        );
      }

      // If this is the last attempt, throw timeout error
      if (attempt === maxAttempts) {
        this.logger.warn("[RunLocker] Lock acquisition exhausted all retries", {
          name,
          resources: sortedResources,
          attempts: attempt + 1,
          totalWaitTime: Math.round(totalWaitTime),
          lastError: lastError.message,
        });
        throw new LockAcquisitionTimeoutError(
          sortedResources,
          Math.round(totalWaitTime),
          attempt + 1,
          `Lock acquisition on resources [${sortedResources.join(", ")}] failed after ${
            attempt + 1
          } attempts`
        );
      }

      // Check if it's a retryable error (lock contention)
      // ExecutionError: General redlock failure (including lock contention)
      // ResourceLockedError: Specific lock contention error (if thrown)
      const isRetryableError =
        error && (error.name === "ResourceLockedError" || error.name === "ExecutionError");

      if (isRetryableError) {
        // Calculate exponential backoff delay with jitter and cap
        const exponentialDelay = Math.min(
          baseDelay * Math.pow(backoffMultiplier, attempt),
          maxDelay
        );
        const jitter = exponentialDelay * jitterFactor * (Math.random() * 2 - 1); // ±jitterFactor% jitter
        const delay = Math.min(maxDelay, Math.max(0, Math.round(exponentialDelay + jitter)));

        // Update total wait time before delay
        totalWaitTime += delay;

        this.logger.debug("[RunLocker] Lock acquisition failed, retrying with backoff", {
          name,
          resources: sortedResources,
          attempt: attempt + 1,
          delay,
          totalWaitTime: Math.round(totalWaitTime),
          error: error.message,
          errorName: error.name,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // For other errors (non-retryable), throw immediately
      this.logger.error("[RunLocker] Lock acquisition failed with non-retryable error", {
        name,
        resources: sortedResources,
        attempt: attempt + 1,
        error: lastError.message,
        errorName: lastError.name,
      });
      throw lastError;
    }

    // Safety guard: ensure lock was successfully acquired
    if (!lock) {
      this.logger.error("[RunLocker] Lock was not acquired despite completing retry loop", {
        name,
        resources: sortedResources,
        maxAttempts,
        totalWaitTime: Math.round(totalWaitTime),
        lastError: lastError?.message,
      });
      throw new LockAcquisitionTimeoutError(
        sortedResources,
        Math.round(totalWaitTime),
        maxAttempts + 1,
        `Lock acquisition on resources [${sortedResources.join(", ")}] failed unexpectedly`
      );
    }

    // Create an AbortController for our signal
    const controller = new AbortController();
    const signal = controller.signal as redlock.RedlockAbortSignal;

    const manualContext: ManualLockContext = {
      lock: lock!,
      timeout: undefined,
      extension: undefined,
    };

    // Track the manual context for cleanup
    this.activeManualContexts.set(lockId, manualContext);

    // Set up auto-extension starting from when lock was actually acquired
    this.#setupAutoExtension(manualContext, duration, signal, controller);

    try {
      const newContext: LockContext = {
        resources: joinedResources,
        signal,
        lockType: name,
      };

      // Track active lock
      this.activeLocks.set(lockId, {
        lockType: name,
        resources: sortedResources,
      });

      let lockSuccess = true;
      try {
        const result = await this.asyncLocalStorage.run(newContext, async () => {
          return routine();
        });

        return result;
      } catch (lockError) {
        lockSuccess = false;
        throw lockError;
      } finally {
        // Record lock duration
        const lockDuration = performance.now() - lockStartTime;
        this.lockDurationHistogram.record(lockDuration, {
          [SemanticAttributes.LOCK_TYPE]: name,
          [SemanticAttributes.LOCK_SUCCESS]: lockSuccess.toString(),
        });

        // Remove from active locks when done
        this.activeLocks.delete(lockId);
      }
    } finally {
      // Remove from active manual contexts
      this.activeManualContexts.delete(lockId);

      // Clean up extension mechanism - this ensures auto extension stops after routine finishes
      this.#cleanupExtension(manualContext);

      // Release the lock using tryCatch
      const [releaseError] = await tryCatch(lock!.release());
      if (releaseError) {
        this.logger.warn("[RunLocker] Error releasing lock", {
          error: releaseError,
          resources: sortedResources,
          lockValue: lock!.value,
        });
      }
    }
  }

  /** Set up automatic lock extension */
  #setupAutoExtension(
    context: ManualLockContext,
    duration: number,
    signal: redlock.RedlockAbortSignal,
    controller: AbortController
  ): void {
    if (this.automaticExtensionThreshold > duration - 100) {
      // Don't set up auto-extension if duration is too short
      return;
    }

    const scheduleExtension = (): void => {
      const timeUntilExtension =
        context.lock.expiration - Date.now() - this.automaticExtensionThreshold;

      if (timeUntilExtension > 0) {
        // Check for cleanup immediately before scheduling to prevent race condition
        if (context.timeout !== null) {
          context.timeout = setTimeout(() => {
            context.extension = this.#extendLock(
              context,
              duration,
              signal,
              controller,
              scheduleExtension
            );
          }, timeUntilExtension);
        }
      }
    };

    scheduleExtension();
  }

  /** Extend a lock */
  async #extendLock(
    context: ManualLockContext,
    duration: number,
    signal: redlock.RedlockAbortSignal,
    controller: AbortController,
    scheduleNext: () => void
  ): Promise<void> {
    // Check if cleanup has started before proceeding
    if (context.timeout === null) {
      return;
    }

    context.timeout = undefined;

    const [error, newLock] = await tryCatch(context.lock.extend(duration));

    if (!error && newLock) {
      context.lock = newLock;
      // Schedule next extension (cleanup check is now inside scheduleNext)
      scheduleNext();
    } else {
      if (context.lock.expiration > Date.now()) {
        // If lock hasn't expired yet, schedule a retry instead of recursing
        // This prevents stack overflow from repeated extension failures
        if (context.timeout !== null) {
          const retryDelay = 100; // Short delay before retry
          context.timeout = setTimeout(() => {
            context.extension = this.#extendLock(
              context,
              duration,
              signal,
              controller,
              scheduleNext
            );
          }, retryDelay);
        }
      } else {
        // Lock has expired, abort the signal
        signal.error = error instanceof Error ? error : new Error(String(error));
        controller.abort();
      }
    }
  }

  /** Clean up extension mechanism */
  #cleanupExtension(context: ManualLockContext): void {
    // Signal that we're cleaning up by setting timeout to null
    if (context.timeout) {
      clearTimeout(context.timeout);
    }
    context.timeout = null;

    // Wait for any in-flight extension to complete
    if (context.extension) {
      context.extension.catch(() => {
        // Ignore errors during cleanup
      });
    }
  }

  async lockIf<T>(
    condition: boolean,
    name: string,
    resources: string[],
    routine: () => Promise<T>
  ): Promise<T> {
    if (condition) {
      return this.lock(name, resources, routine);
    } else {
      return routine();
    }
  }

  isInsideLock(): boolean {
    return !!this.asyncLocalStorage.getStore();
  }

  getCurrentResources(): string | undefined {
    return this.asyncLocalStorage.getStore()?.resources;
  }

  getRetryConfig(): Readonly<Required<LockRetryConfig>> {
    return { ...this.retryConfig };
  }

  getDuration(): number {
    return this.duration;
  }

  getAutomaticExtensionThreshold(): number {
    return this.automaticExtensionThreshold;
  }

  async quit() {
    // Clean up all active manual contexts
    for (const [lockId, context] of this.activeManualContexts) {
      this.#cleanupExtension(context);

      // Try to release any remaining locks
      const [releaseError] = await tryCatch(context.lock.release());
      if (releaseError) {
        this.logger.warn("[RunLocker] Error releasing lock during quit", {
          error: releaseError,
          lockId,
          lockValue: context.lock.value,
        });
      }
    }

    this.activeManualContexts.clear();
    this.activeLocks.clear();

    await this.redlock.quit();
  }
}
