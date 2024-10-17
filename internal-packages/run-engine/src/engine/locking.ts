import Redis from "ioredis";
import Redlock, { RedlockAbortSignal } from "redlock";
import { AsyncLocalStorage } from "async_hooks";

interface LockContext {
  resources: string;
  signal: RedlockAbortSignal;
}

export class RunLocker {
  private redlock: Redlock;
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
    routine: (signal: RedlockAbortSignal) => Promise<T>
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
}
