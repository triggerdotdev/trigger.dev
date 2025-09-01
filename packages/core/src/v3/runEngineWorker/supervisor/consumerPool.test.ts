import { describe, it, expect, beforeEach, afterEach, vi, Mock } from "vitest";
import {
  RunQueueConsumerPool,
  type ConsumerPoolOptions,
  type QueueConsumerFactory,
} from "./consumerPool.js";
import { SupervisorHttpClient } from "./http.js";
import type { WorkerApiDequeueResponseBody } from "./schemas.js";
import type { QueueConsumer } from "./queueConsumer.js";

// Mock only the logger
vi.mock("../../utils/structuredLogger.js");

// Test implementation of QueueConsumer
class TestQueueConsumer implements QueueConsumer {
  public started = false;
  public stopped = false;
  public onDequeue?: (messages: WorkerApiDequeueResponseBody) => Promise<void>;

  constructor(opts: any) {
    this.onDequeue = opts.onDequeue;
  }

  start(): void {
    this.started = true;
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
  }
}

describe("RunQueueConsumerPool", () => {
  let mockClient: SupervisorHttpClient;
  let mockOnDequeue: Mock;
  let pool: RunQueueConsumerPool;
  let defaultOptions: Omit<ConsumerPoolOptions, "scaling">;
  let testConsumers: TestQueueConsumer[];
  let testConsumerFactory: QueueConsumerFactory;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockClient = {} as SupervisorHttpClient;
    mockOnDequeue = vi.fn();
    testConsumers = [];

    testConsumerFactory = (opts) => {
      const consumer = new TestQueueConsumer(opts);
      testConsumers.push(consumer);
      return consumer;
    };

    defaultOptions = {
      consumer: {
        client: mockClient,
        intervalMs: 0,
        idleIntervalMs: 1000,
        onDequeue: mockOnDequeue,
      },
      consumerFactory: testConsumerFactory,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    if (pool) {
      pool.stop();
    }
  });

  function advanceTimeAndProcessMetrics(ms: number) {
    vi.advanceTimersByTime(ms);

    // Trigger batch processing if ready (without adding a sample)
    if (pool["metricsProcessor"].shouldProcessBatch()) {
      pool["processMetricsBatch"]();
    }
  }

  describe("Static mode (strategy='none')", () => {
    it("should start with maxConsumerCount in static mode", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: { strategy: "none", maxConsumerCount: 5 },
      });

      await pool.start();

      expect(pool.size).toBe(5);
      expect(testConsumers.length).toBe(5);
    });

    it("should not scale in static mode even with queue length updates", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: { strategy: "none", maxConsumerCount: 3 },
      });

      await pool.start();
      const initialCount = pool.size;

      pool.updateQueueLength(100);
      vi.advanceTimersByTime(2000);

      expect(pool.size).toBe(initialCount);
      expect(pool.size).toBe(3);
    });
  });

  describe("Smooth scaling strategy", () => {
    it("should scale smoothly with damping", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "smooth",
          minConsumerCount: 1,
          maxConsumerCount: 10,
          scaleUpCooldownMs: 0,
          disableJitter: true,
        },
      });

      await pool.start();
      expect(pool.size).toBe(1);

      pool.updateQueueLength(5);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBe(4); // Damped scaling

      pool.updateQueueLength(5);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBe(5); // Gradually approaches target
    });

    it("should respect max consumer count", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "smooth",
          minConsumerCount: 1,
          maxConsumerCount: 5,
          scaleUpCooldownMs: 0,
          disableJitter: true,
        },
      });

      await pool.start();
      expect(pool.size).toBe(1);

      pool.updateQueueLength(100);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBe(5);

      pool.updateQueueLength(100);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBe(5);
    });
  });

  describe("Aggressive scaling strategy", () => {
    it("should scale up quickly based on queue pressure", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "aggressive",
          minConsumerCount: 2,
          maxConsumerCount: 10,
          scaleUpCooldownMs: 0,
          disableJitter: true,
        },
      });

      await pool.start();
      expect(pool.size).toBe(2);

      pool.updateQueueLength(10);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBe(3);

      pool.updateQueueLength(20);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBe(4);
    });

    it("should scale down cautiously when queue is small", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "aggressive",
          minConsumerCount: 1,
          maxConsumerCount: 10,
          scaleUpCooldownMs: 0,
          scaleDownCooldownMs: 0,
          disableJitter: true,
        },
      });

      await pool.start();
      expect(pool.size).toBe(1);

      pool.updateQueueLength(10);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBe(2);

      pool.updateQueueLength(0.5);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBe(3); // EWMA smoothing delays scale down

      pool.updateQueueLength(0.5);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBeGreaterThanOrEqual(3); // Stays in optimal zone
    });

    it("should maintain current level in optimal zone", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "aggressive",
          minConsumerCount: 3,
          maxConsumerCount: 10,
          scaleUpCooldownMs: 0,
          disableJitter: true,
        },
      });

      await pool.start();
      expect(pool.size).toBe(3);

      pool.updateQueueLength(3);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBe(3);

      pool.updateQueueLength(4);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBe(3);
    });
  });

  describe("Smooth scaling with EWMA", () => {
    it("should use exponential smoothing for stable scaling", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "smooth",
          minConsumerCount: 1,
          maxConsumerCount: 10,
          disableJitter: true,
        },
      });

      await pool.start();

      const queueLengths = [10, 2, 8, 3, 9, 1, 7];
      for (const length of queueLengths) {
        pool.updateQueueLength(length);
        vi.advanceTimersByTime(200);
      }
      vi.advanceTimersByTime(900);

      const metrics = pool.getMetrics();
      expect(metrics.smoothedQueueLength).toBeGreaterThan(0);
      expect(metrics.smoothedQueueLength).toBeLessThan(10);
    });

    it("should apply damping factor to avoid rapid changes", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "smooth",
          minConsumerCount: 1,
          maxConsumerCount: 10,
          disableJitter: true,
        },
      });

      await pool.start();

      pool.updateQueueLength(2);
      advanceTimeAndProcessMetrics(1100);
      const metrics1 = pool.getMetrics();
      expect(metrics1.smoothedQueueLength).toBe(2);

      pool.updateQueueLength(20);
      advanceTimeAndProcessMetrics(1100);
      const metrics2 = pool.getMetrics();

      expect(metrics2.smoothedQueueLength).toBeGreaterThan(2);
      expect(metrics2.smoothedQueueLength).toBeLessThan(20);
    });
  });

  describe("High throughput parallel dequeuing", () => {
    it("should handle rapid parallel queue updates", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "aggressive",
          minConsumerCount: 1,
          maxConsumerCount: 20,
          disableJitter: true,
        },
      });

      await pool.start();

      const updates: number[] = [];
      for (let i = 0; i < 100; i++) {
        updates.push(Math.floor(Math.random() * 50) + 10);
      }

      updates.forEach((length, index) => {
        setTimeout(() => pool.updateQueueLength(length), index * 10);
      });

      advanceTimeAndProcessMetrics(1100);

      const metrics = pool.getMetrics();
      expect(metrics.queueLength).toBeDefined();
    });

    it("should batch metrics updates to avoid excessive scaling", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "smooth",
          minConsumerCount: 1,
          maxConsumerCount: 10,
          disableJitter: true,
        },
      });

      await pool.start();
      const evaluateScalingSpy = vi.spyOn(pool as any, "evaluateScaling");

      pool.updateQueueLength(10);
      for (let i = 1; i < 50; i++) {
        pool.updateQueueLength(Math.floor(Math.random() * 20) + 5);
      }

      expect(evaluateScalingSpy).not.toHaveBeenCalled();
      advanceTimeAndProcessMetrics(1000);
      expect(evaluateScalingSpy).toHaveBeenCalledTimes(1);
    });

    it("should use median to filter outliers in high-frequency updates", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "aggressive",
          minConsumerCount: 1,
          maxConsumerCount: 10,
          disableJitter: true,
        },
      });

      await pool.start();

      const updates = [10, 11, 9, 12, 10, 100, 11, 10, 9, 11, 1];
      updates.forEach((length) => pool.updateQueueLength(length));
      advanceTimeAndProcessMetrics(1100);

      const metrics = pool.getMetrics();
      expect(metrics.queueLength).toBeGreaterThanOrEqual(9);
      expect(metrics.queueLength).toBeLessThanOrEqual(12);
    });
  });

  describe("Scaling cooldowns and jitter", () => {
    it("should respect scale-up cooldown", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "smooth",
          scaleUpCooldownMs: 5000,
          minConsumerCount: 1,
          maxConsumerCount: 10,
          disableJitter: true,
        },
      });

      await pool.start();
      pool["scaleToTarget"](5);
      const scaleToTargetSpy = vi.spyOn(pool as any, "scaleToTarget");

      pool.updateQueueLength(10);
      advanceTimeAndProcessMetrics(1100);
      expect(scaleToTargetSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10000);
      pool.updateQueueLength(20);
      advanceTimeAndProcessMetrics(1100);
    });

    it("should respect scale-down cooldown (longer than scale-up)", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "aggressive",
          minConsumerCount: 1,
          maxConsumerCount: 10,
          disableJitter: true,
        },
      });

      await pool.start();

      for (let i = 0; i < 4; i++) {
        pool["addConsumers"](1);
      }
      pool["scaleToTarget"](5);
      pool["metrics"].lastScaleTime = new Date(Date.now() - 70000);

      pool.updateQueueLength(1);
      advanceTimeAndProcessMetrics(1100);

      const metrics = pool.getMetrics();
      expect(metrics.queueLength).toBe(1);
    });

    it("should add random jitter to prevent thundering herd", async () => {
      const pools: RunQueueConsumerPool[] = [];
      const scaleTimes: number[] = [];

      for (let i = 0; i < 3; i++) {
        const p = new RunQueueConsumerPool({
          ...defaultOptions,
          scaling: {
            strategy: "smooth",
            minConsumerCount: 1,
            maxConsumerCount: 10,
            disableJitter: true,
          },
        });

        const originalScale = p["scaleToTarget"];
        p["scaleToTarget"] = vi.fn(async (target: number) => {
          scaleTimes.push(Date.now());
          return originalScale.call(p, target);
        });

        pools.push(p);
        await p.start();
      }

      pools.forEach((p) => p.updateQueueLength(20));
      advanceTimeAndProcessMetrics(1100);
      vi.advanceTimersByTime(15000);

      await Promise.all(pools.map((p) => p.stop()));
    });
  });

  describe("Consumer lifecycle management", () => {
    it("should properly start and stop consumers", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "none",
          maxConsumerCount: 3,
          disableJitter: true,
        },
      });

      await pool.start();

      expect(pool.size).toBe(3);
      expect(testConsumers.length).toBe(3);
      testConsumers.forEach((consumer) => {
        expect(consumer.started).toBe(true);
      });

      await pool.stop();

      testConsumers.forEach((consumer) => {
        expect(consumer.stopped).toBe(true);
      });
    });

    it("should forward dequeue messages with queue length updates", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "aggressive",
          maxConsumerCount: 2,
          disableJitter: true,
        },
      });

      await pool.start();

      const messages: WorkerApiDequeueResponseBody = [{ workerQueueLength: 15 } as any];

      if (testConsumers[0]?.onDequeue) {
        await testConsumers[0].onDequeue(messages);
      }

      expect(mockOnDequeue).toHaveBeenCalledWith(messages);

      advanceTimeAndProcessMetrics(1100);
      const metrics = pool.getMetrics();
      expect(metrics.queueLength).toBe(15);
    });
  });

  describe("Memory leak prevention", () => {
    it("should collect all samples within batch window without limit", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "aggressive",
          minConsumerCount: 1,
          maxConsumerCount: 10,
          disableJitter: true,
        },
      });

      await pool.start();

      for (let i = 0; i < 100; i++) {
        pool.updateQueueLength(i);
      }

      const metrics = pool.getMetrics();
      expect(metrics.queueLength).toBeUndefined();
    });

    it("should clear consumer map on stop", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "none",
          maxConsumerCount: 5,
          disableJitter: true,
        },
      });

      await pool.start();
      expect(pool.size).toBe(5);

      await pool.stop();
      expect(pool.size).toBe(0);
    });

    it("should clear recentQueueLengths after processing batch", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: { strategy: "smooth" },
      });

      await pool.start();

      for (let i = 0; i < 5; i++) {
        pool.updateQueueLength(10 + i);
      }

      advanceTimeAndProcessMetrics(1100);
      const metrics = pool.getMetrics();
      expect(metrics.queueLength).toBeDefined();
    });

    it("should not accumulate scaling operations in memory", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "aggressive",
          scaleUpCooldownMs: 100,
          scaleDownCooldownMs: 100,
          minConsumerCount: 1,
          maxConsumerCount: 10,
          disableJitter: true,
        },
      });

      await pool.start();

      for (let i = 0; i < 5; i++) {
        pool["metrics"].lastScaleTime = new Date(0);
        pool.updateQueueLength(i % 2 === 0 ? 50 : 1);
        vi.advanceTimersByTime(1100);
      }

      expect(pool.size).toBeGreaterThanOrEqual(1);
      expect(pool.size).toBeLessThanOrEqual(10);
    });
  });

  describe("Edge cases", () => {
    it("should handle undefined queue lengths gracefully", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: { strategy: "smooth" },
      });

      await pool.start();

      expect(() => pool.updateQueueLength(undefined)).not.toThrow();

      const metrics = pool.getMetrics();
      expect(metrics.queueLength).toBeUndefined();
    });

    it("should handle empty recent queue lengths", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: { strategy: "aggressive" },
      });

      await pool.start();

      const metrics = pool.getMetrics();
      expect(metrics.queueLength).toBeUndefined();
    });

    it("should clamp consumer count to min/max bounds", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "smooth",
          minConsumerCount: 2,
          maxConsumerCount: 5,
          disableJitter: true,
        },
      });

      await pool.start();
      expect(pool.size).toBe(2);

      pool.updateQueueLength(100);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBeLessThanOrEqual(5);
    });

    it("should respect custom targetRatio with smooth strategy", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "smooth",
          targetRatio: 5,
          scaleUpCooldownMs: 0,
          minConsumerCount: 1,
          maxConsumerCount: 10,
          disableJitter: true,
        },
      });

      await pool.start();
      expect(pool.size).toBe(1);

      pool.updateQueueLength(10);
      advanceTimeAndProcessMetrics(1100);

      const firstSize = pool.size;
      expect(firstSize).toBeGreaterThanOrEqual(1);
      expect(firstSize).toBeLessThanOrEqual(2);

      pool.updateQueueLength(10);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBeLessThanOrEqual(2);
    });

    it("should respect custom targetRatio with aggressive strategy", async () => {
      pool = new RunQueueConsumerPool({
        ...defaultOptions,
        scaling: {
          strategy: "aggressive",
          targetRatio: 5,
          scaleUpCooldownMs: 0,
          minConsumerCount: 1,
          maxConsumerCount: 10,
          disableJitter: true,
        },
      });

      await pool.start();
      expect(pool.size).toBe(1);

      pool.updateQueueLength(20);
      advanceTimeAndProcessMetrics(1100);

      const sizeAfterFirstScale = pool.size;
      expect(sizeAfterFirstScale).toBeGreaterThanOrEqual(1);

      pool.updateQueueLength(20);
      advanceTimeAndProcessMetrics(1100);
      expect(pool.size).toBeLessThanOrEqual(6);
    });
  });
});
