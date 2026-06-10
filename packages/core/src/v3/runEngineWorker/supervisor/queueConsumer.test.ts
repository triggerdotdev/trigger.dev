import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Registry } from "prom-client";
import { RunQueueConsumer } from "./queueConsumer.js";
import { ConsumerPoolMetrics } from "./consumerPoolMetrics.js";
import type { SupervisorHttpClient } from "./http.js";
import type { WorkerApiDequeueResponseBody } from "./schemas.js";

// Mock only the logger (same approach as consumerPool.test.ts)
vi.mock("../../utils/structuredLogger.js");

function makeClient(dequeueImpl: () => Promise<unknown>): SupervisorHttpClient {
  return { dequeue: vi.fn(dequeueImpl) } as unknown as SupervisorHttpClient;
}

describe("RunQueueConsumer dequeue latency metric", () => {
  let register: Registry;
  let metrics: ConsumerPoolMetrics;
  let consumer: RunQueueConsumer | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // Fake timers so the trailing scheduleNextDequeue() never fires during the test.
    vi.useFakeTimers();
    register = new Registry();
    metrics = new ConsumerPoolMetrics({ register });
  });

  afterEach(() => {
    consumer?.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /**
   * Runs exactly one dequeue iteration and awaits it. We set `isEnabled`
   * directly and invoke the private `dequeue()` rather than `start()`, so no
   * timer-driven loop runs - the metric is recorded before scheduleNextDequeue().
   */
  async function runOneDequeue(opts: {
    dequeueImpl: () => Promise<unknown>;
    withMetrics?: boolean;
  }) {
    consumer = new RunQueueConsumer({
      client: makeClient(opts.dequeueImpl),
      intervalMs: 600_000,
      idleIntervalMs: 600_000,
      onDequeue: async () => {},
      ...(opts.withMetrics === false ? {} : { metrics }),
    });

    (consumer as unknown as { isEnabled: boolean }).isEnabled = true;
    await (consumer as unknown as { dequeue(): Promise<void> }).dequeue();
  }

  it('records outcome="empty" for a successful empty dequeue', async () => {
    await runOneDequeue({ dequeueImpl: async () => ({ success: true, data: [] }) });

    expect(await register.metrics()).toContain(
      'queue_consumer_pool_dequeue_duration_seconds_count{outcome="empty"} 1'
    );
  });

  it('records outcome="success" once per round-trip, regardless of message count', async () => {
    const messages = [{ run: {} }, { run: {} }] as unknown as WorkerApiDequeueResponseBody;
    await runOneDequeue({ dequeueImpl: async () => ({ success: true, data: messages }) });

    const text = await register.metrics();
    // One observation for the whole batch, not one per message.
    expect(text).toContain('queue_consumer_pool_dequeue_duration_seconds_count{outcome="success"} 1');
  });

  it('records outcome="error" when the response is unsuccessful', async () => {
    await runOneDequeue({
      dequeueImpl: async () => ({ success: false, error: new Error("boom") }),
    });

    expect(await register.metrics()).toContain(
      'queue_consumer_pool_dequeue_duration_seconds_count{outcome="error"} 1'
    );
  });

  // Defensive path: wrapZodFetch traps all errors today, so the real client
  // never throws - this guards against a future client that does.
  it('records outcome="error" when the dequeue call throws', async () => {
    await runOneDequeue({
      dequeueImpl: async () => {
        throw new Error("network down");
      },
    });

    expect(await register.metrics()).toContain(
      'queue_consumer_pool_dequeue_duration_seconds_count{outcome="error"} 1'
    );
  });

  it("is a no-op (does not throw) when no metrics instance is provided", async () => {
    await expect(
      runOneDequeue({ dequeueImpl: async () => ({ success: true, data: [] }), withMetrics: false })
    ).resolves.not.toThrow();

    // Histogram has no observations - the labelled count line should be absent.
    expect(await register.metrics()).not.toContain("queue_consumer_pool_dequeue_duration_seconds_count");
  });
});
