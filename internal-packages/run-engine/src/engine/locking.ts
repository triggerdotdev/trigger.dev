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

export class RunLocker {
  private redlock: InstanceType<typeof redlock.default>;
  private asyncLocalStorage: AsyncLocalStorage<LockContext>;
  private logger: Logger;
  private tracer: Tracer;
  private meter: Meter;
  private activeLocks: Map<string, { lockType: string; resources: string[] }> = new Map();
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
          this.redlock.using(resources, duration, async (signal) => {
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
              return this.asyncLocalStorage.run(newContext, async () => {
                return routine(signal);
              });
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
          })
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

  async lockIf<T>(
    condition: boolean,
    name: string,
    resources: string[],
    duration: number,
    routine: () => Promise<T>
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
    await this.redlock.quit();
  }
}
