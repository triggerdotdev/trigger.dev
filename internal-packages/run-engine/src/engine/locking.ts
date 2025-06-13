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

export class RunLocker {
  private redlock: InstanceType<typeof redlock.default>;
  private asyncLocalStorage: AsyncLocalStorage<LockContext>;
  private logger: Logger;
  private tracer: Tracer;
  private meter: Meter;
  private activeLocks: Map<string, { lockType: string; resources: string[] }> = new Map();
  private activeManualContexts: Map<string, ManualLockContext> = new Map();
  private lockDurationHistogram: Histogram;

  constructor(options: { redis: Redis; logger: Logger; tracer: Tracer; meter?: Meter }) {
    this.redlock = new Redlock([options.redis], {
      driftFactor: 0.01,
      retryCount: 10,
      retryDelay: 200, // time in ms
      retryJitter: 200, // time in ms
      automaticExtensionThreshold: 500, // time in ms
    });
    this.asyncLocalStorage = new AsyncLocalStorage<LockContext>();
    this.logger = options.logger;
    this.tracer = options.tracer;
    this.meter = options.meter ?? getMeter("run-engine");

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
  async lock<T>(
    name: string,
    resources: string[],
    duration: number,
    routine: (signal: redlock.RedlockAbortSignal) => Promise<T>
  ): Promise<T> {
    const currentContext = this.asyncLocalStorage.getStore();
    const joinedResources = resources.sort().join(",");

    return startSpan(
      this.tracer,
      "RunLocker.lock",
      async (span) => {
        if (currentContext && currentContext.resources === joinedResources) {
          span.setAttribute("nested", true);
          // We're already inside a lock with the same resources, just run the routine
          return routine(currentContext.signal);
        }

        span.setAttribute("nested", false);

        // Different resources or not in a lock, proceed with new lock
        const lockId = `${name}:${joinedResources}:${Date.now()}`;
        const lockStartTime = performance.now();

        const [error, result] = await tryCatch(
          this.#acquireAndExecute(name, resources, duration, routine, lockId, lockStartTime)
        );

        if (error) {
          // Record failed lock acquisition
          const lockDuration = performance.now() - lockStartTime;
          this.lockDurationHistogram.record(lockDuration, {
            [SemanticAttributes.LOCK_TYPE]: name,
            [SemanticAttributes.LOCK_SUCCESS]: "false",
          });

          this.logger.error("[RunLocker] Error locking resources", { error, resources, duration });
          throw error;
        }

        return result;
      },
      {
        attributes: { name, resources, timeout: duration },
      }
    );
  }

  /** Manual lock acquisition with custom retry logic */
  async #acquireAndExecute<T>(
    name: string,
    resources: string[],
    duration: number,
    routine: (signal: redlock.RedlockAbortSignal) => Promise<T>,
    lockId: string,
    lockStartTime: number
  ): Promise<T> {
    const joinedResources = resources.sort().join(",");

    // Custom retry settings
    const maxRetries = 10;
    const baseDelay = 200;
    const jitter = 200;

    // Retry the lock acquisition specifically using tryCatch
    let lock: redlock.Lock;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const [error, acquiredLock] = await tryCatch(this.redlock.acquire(resources, duration));

      if (!error && acquiredLock) {
        lock = acquiredLock;
        break;
      }

      // If this is the last attempt, throw the error
      if (attempt === maxRetries) {
        throw error || new Error("Failed to acquire lock after maximum retries");
      }

      // If it's a ResourceLockedError, we should retry
      if (error && error.name === "ResourceLockedError") {
        // Calculate delay with jitter
        const delay = baseDelay + Math.floor((Math.random() * 2 - 1) * jitter);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)));
        continue;
      }

      // For other errors, throw immediately
      throw error || new Error("Unknown error during lock acquisition");
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
        resources: resources,
      });

      let lockSuccess = true;
      try {
        const result = await this.asyncLocalStorage.run(newContext, async () => {
          return routine(signal);
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
          resources,
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
    const automaticExtensionThreshold = 500; // Same as redlock default

    if (automaticExtensionThreshold > duration - 100) {
      // Don't set up auto-extension if duration is too short
      return;
    }

    const scheduleExtension = (): void => {
      const timeUntilExtension = context.lock.expiration - Date.now() - automaticExtensionThreshold;

      if (timeUntilExtension > 0) {
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
    context.timeout = undefined;

    const [error, newLock] = await tryCatch(context.lock.extend(duration));

    if (!error && newLock) {
      context.lock = newLock;
      // Only schedule next extension if we haven't been cleaned up
      if (context.timeout !== null) {
        scheduleNext();
      }
    } else {
      if (context.lock.expiration > Date.now()) {
        // If lock hasn't expired yet, try again (but only if not cleaned up)
        if (context.timeout !== null) {
          return this.#extendLock(context, duration, signal, controller, scheduleNext);
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
    duration: number,
    routine: (signal?: redlock.RedlockAbortSignal) => Promise<T>
  ): Promise<T> {
    if (condition) {
      return this.lock(name, resources, duration, routine);
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
