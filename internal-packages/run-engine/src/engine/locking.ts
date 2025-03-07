// import { default: Redlock } from "redlock";
const { default: Redlock } = require("redlock");
import { AsyncLocalStorage } from "async_hooks";
import { Redis } from "@internal/redis";
import * as redlock from "redlock";

interface LockContext {
  resources: string;
  signal: redlock.RedlockAbortSignal;
}

export class RunLocker {
  private redlock: InstanceType<typeof redlock.default>;
  private asyncLocalStorage: AsyncLocalStorage<LockContext>;

  constructor(options: { redis: Redis }) {
    this.redlock = new Redlock([options.redis], {
      driftFactor: 0.01,
      retryCount: 10,
      retryDelay: 200, // time in ms
      retryJitter: 200, // time in ms
      automaticExtensionThreshold: 500, // time in ms
    });
    this.asyncLocalStorage = new AsyncLocalStorage<LockContext>();
  }

  /** Locks resources using RedLock. It won't lock again if we're already inside a lock with the same resources. */
  async lock<T>(
    resources: string[],
    duration: number,
    routine: (signal: redlock.RedlockAbortSignal) => Promise<T>
  ): Promise<T> {
    const currentContext = this.asyncLocalStorage.getStore();
    const joinedResources = resources.sort().join(",");

    if (currentContext && currentContext.resources === joinedResources) {
      // We're already inside a lock with the same resources, just run the routine
      return routine(currentContext.signal);
    }

    // Different resources or not in a lock, proceed with new lock
    return this.redlock.using(resources, duration, async (signal) => {
      const newContext: LockContext = { resources: joinedResources, signal };

      return this.asyncLocalStorage.run(newContext, async () => {
        return routine(signal);
      });
    });
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
