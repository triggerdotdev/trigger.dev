import type { SupervisorSession } from "@trigger.dev/core/v3/workers";
import type { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";

/**
 * Lets a shutdown wait for the session's dequeue requests and the message handlers
 * they start. The session's stop waits for neither: a request in flight still emits
 * its messages, and the emit does not await the handlers.
 */
export class DequeueDrain {
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    session: SupervisorSession,
    private readonly logger: SimpleStructuredLogger
  ) {
    const client = session.httpClient;
    const dequeue = client.dequeue.bind(client);
    client.dequeue = (...args) => {
      // A consumer stopped while awaiting its pre-dequeue check still makes the request.
      if (this.stopped) {
        return Promise.resolve({ success: true as const, data: [] });
      }
      return this.track(dequeue(...args));
    };
  }

  /**
   * Wraps an async listener so `stop` waits for each call of it. Tracking handles
   * its rejection, which would otherwise crash the process, so it is logged here.
   */
  tracked<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
    return (...args) => {
      const call = fn(...args);
      call.catch((error: unknown) =>
        this.logger.error("Dequeued message handler failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      );
      return this.track(call);
    };
  }

  /** Admits no more dequeues and resolves once the requests and handlers in flight settle. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pending.size > 0) {
      // Logged first: anything still pending when the shutdown times out is lost.
      this.logger.log("Draining dequeues in flight", { inFlight: this.pending.size });
    }
    // A request that settles here starts its handlers before the next check.
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending);
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const remove = () => this.pending.delete(promise);
    promise.then(remove, remove);
    return promise;
  }
}
