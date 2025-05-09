// import { default: Redlock } from "redlock";
const { default: Redlock } = require("redlock");
import { AsyncLocalStorage } from "async_hooks";
import { Redis } from "@internal/redis";
import * as redlock from "redlock";
import { tryCatch } from "@trigger.dev/core";
import { Logger } from "@trigger.dev/core/logger";
import { startSpan, Tracer } from "@internal/tracing";

interface LockContext {
  resources: string;
  signal: redlock.RedlockAbortSignal;
}

export class RunLocker {
  private redlock: InstanceType<typeof redlock.default>;
  private asyncLocalStorage: AsyncLocalStorage<LockContext>;
  private logger: Logger;
  private tracer: Tracer;

  constructor(options: { redis: Redis; logger: Logger; tracer: Tracer }) {
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
        const [error, result] = await tryCatch(
          this.redlock.using(resources, duration, async (signal) => {
            const newContext: LockContext = { resources: joinedResources, signal };

            return this.asyncLocalStorage.run(newContext, async () => {
              return routine(signal);
            });
          })
        );

        if (error) {
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
