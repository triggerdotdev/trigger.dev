import { describe, it, expect } from "vitest";
import {
  NoneScalingStrategy,
  SmoothScalingStrategy,
  AggressiveScalingStrategy,
  ScalingStrategyOptions,
} from "./scalingStrategies.js";
import { QueueMetricsProcessor } from "./queueMetricsProcessor.js";

describe("Scaling Strategies", () => {
  const baseOptions: ScalingStrategyOptions = {
    minConsumerCount: 1,
    maxConsumerCount: 20,
    targetRatio: 1.0,
  };

  function createMetricsProcessor(smoothedValue: number): QueueMetricsProcessor {
    const processor = new QueueMetricsProcessor({ ewmaAlpha: 0.3, batchWindowMs: 1000 });
    // Initialize processor with the target smoothed value
    processor.addSample(smoothedValue);
    processor.processBatch();
    return processor;
  }

  describe("NoneScalingStrategy", () => {
    const strategy = new NoneScalingStrategy(baseOptions);

    it("should always return current count (static mode)", () => {
      expect(strategy.calculateTargetCount(5)).toBe(5);
      expect(strategy.calculateTargetCount(1)).toBe(1);
      expect(strategy.calculateTargetCount(10)).toBe(10);
      // Clamping still applies
      expect(strategy.calculateTargetCount(25)).toBe(20); // Clamped to max
      expect(strategy.calculateTargetCount(0)).toBe(1); // Clamped to min
    });

    it("should have correct name", () => {
      expect(strategy.name).toBe("none");
    });

    it("should handle zero current count", () => {
      // Should clamp to minConsumerCount
      const result = strategy.calculateTargetCount(0);
      expect(result).toBe(1);
    });
  });

  describe("SmoothScalingStrategy", () => {
    it("should calculate target based on smoothed queue length", () => {
      const metricsProcessor = createMetricsProcessor(10); // smoothed value = 10
      const strategy = new SmoothScalingStrategy({ ...baseOptions, metricsProcessor });

      // With targetRatio=1.0, target consumers = ceil(10/1.0) = 10
      // With dampingFactor=0.7 and currentCount=5:
      // dampedTarget = 5 + (10 - 5) * 0.7 = 5 + 3.5 = 8.5 → 9
      const result = strategy.calculateTargetCount(5);
      expect(result).toBe(9);
    });

    it("should apply damping factor correctly", () => {
      const metricsProcessor = createMetricsProcessor(20); // smoothed value = 20
      const strategy = new SmoothScalingStrategy({
        ...baseOptions,
        metricsProcessor,
        dampingFactor: 0.5,
      }); // 50% damping

      // With targetRatio=1.0, target consumers = ceil(20/1.0) = 20
      // With dampingFactor=0.5 and currentCount=5:
      // dampedTarget = 5 + (20 - 5) * 0.5 = 5 + 7.5 = 12.5 → 13
      const result = strategy.calculateTargetCount(5);
      expect(result).toBe(13);
    });

    it("should handle zero current count", () => {
      const metricsProcessor = createMetricsProcessor(5);
      const strategy = new SmoothScalingStrategy({ ...baseOptions, metricsProcessor });

      // With smoothedQueueLength=5, targetRatio=1.0:
      // targetConsumers = ceil(5/1.0) = 5
      // dampedTarget = 0 + (5 - 0) * 0.7 = 3.5 → 4
      const result = strategy.calculateTargetCount(0);
      expect(result).toBe(4);
    });

    it("should validate damping factor", () => {
      const metricsProcessor = createMetricsProcessor(10);
      expect(
        () =>
          new SmoothScalingStrategy({
            ...baseOptions,
            metricsProcessor,
            dampingFactor: -0.1,
          })
      ).toThrow("dampingFactor must be between 0 and 1");

      expect(
        () =>
          new SmoothScalingStrategy({
            ...baseOptions,
            metricsProcessor,
            dampingFactor: 1.1,
          })
      ).toThrow("dampingFactor must be between 0 and 1");

      expect(
        () =>
          new SmoothScalingStrategy({
            ...baseOptions,
            metricsProcessor,
            dampingFactor: 0,
          })
      ).not.toThrow();

      expect(
        () =>
          new SmoothScalingStrategy({
            ...baseOptions,
            metricsProcessor,
            dampingFactor: 1,
          })
      ).not.toThrow();
    });

    it("should handle zero current count", () => {
      const metricsProcessor = createMetricsProcessor(10);
      const strategy = new SmoothScalingStrategy({ ...baseOptions, metricsProcessor });

      // With smoothedQueueLength=10, targetRatio=1.0:
      // targetConsumers = ceil(10/1.0) = 10
      // dampedTarget = 0 + (10 - 0) * 0.7 = 7
      const result = strategy.calculateTargetCount(0);
      expect(result).toBe(7);
    });
  });

  describe("AggressiveScalingStrategy", () => {
    it("should scale down when under-utilized", () => {
      // queuePerConsumer = 2/5 = 0.4, scaleDownThreshold = 1.0 * 0.5 = 0.5
      // Under-utilized since 0.4 < 0.5
      const metricsProcessor = createMetricsProcessor(2);
      const strategy = new AggressiveScalingStrategy({ ...baseOptions, metricsProcessor });

      const result = strategy.calculateTargetCount(5);
      expect(result).toBeLessThan(5);
      expect(result).toBeGreaterThanOrEqual(baseOptions.minConsumerCount);
    });

    it("should maintain count when in optimal zone", () => {
      // queuePerConsumer = 5/5 = 1.0
      // Optimal zone: 0.5 < 1.0 < 2.0
      const metricsProcessor = createMetricsProcessor(5);
      const strategy = new AggressiveScalingStrategy({ ...baseOptions, metricsProcessor });

      const result = strategy.calculateTargetCount(5);
      expect(result).toBe(5);
    });

    it("should scale up when over-utilized", () => {
      // queuePerConsumer = 15/5 = 3.0, scaleUpThreshold = 1.0 * 2.0 = 2.0
      // Over-utilized since 3.0 > 2.0
      const metricsProcessor = createMetricsProcessor(15);
      const strategy = new AggressiveScalingStrategy({ ...baseOptions, metricsProcessor });

      const result = strategy.calculateTargetCount(5);
      expect(result).toBeGreaterThan(5);
      expect(result).toBeLessThanOrEqual(baseOptions.maxConsumerCount);
    });

    it("should scale aggressively for critical load", () => {
      // queuePerConsumer = 25/5 = 5.0 (critical: 5x target ratio)
      const metricsProcessor = createMetricsProcessor(25);
      const strategy = new AggressiveScalingStrategy({ ...baseOptions, metricsProcessor });

      const result = strategy.calculateTargetCount(5);
      // Should apply 50% scale factor: ceil(5 * 1.5) = 8
      // But capped by 50% max increment: 5 + ceil(5 * 0.5) = 5 + 3 = 8
      expect(result).toBe(8);
    });

    it("should respect max consumer count", () => {
      const metricsProcessor = createMetricsProcessor(50); // Very high load
      const strategy = new AggressiveScalingStrategy({
        ...baseOptions,
        maxConsumerCount: 6,
        metricsProcessor,
      });

      const result = strategy.calculateTargetCount(5);
      expect(result).toBeLessThanOrEqual(6);
    });

    it("should respect min consumer count", () => {
      const metricsProcessor = createMetricsProcessor(0.1); // Very low load
      const strategy = new AggressiveScalingStrategy({
        ...baseOptions,
        minConsumerCount: 3,
        metricsProcessor,
      });

      const result = strategy.calculateTargetCount(5);
      expect(result).toBeGreaterThanOrEqual(3);
    });

    it("should return thresholds", () => {
      const metricsProcessor = createMetricsProcessor(10);
      const strategy = new AggressiveScalingStrategy({ ...baseOptions, metricsProcessor });
      const thresholds = strategy.getThresholds(1.0);
      expect(thresholds).toEqual({
        scaleDownThreshold: 0.5,
        scaleUpThreshold: 2.0,
        criticalThreshold: 5.0,
        highThreshold: 3.0,
      });
    });

    it("should handle zero current count without division by zero", () => {
      const metricsProcessor = createMetricsProcessor(10);
      const strategy = new AggressiveScalingStrategy({ ...baseOptions, metricsProcessor });

      // Should use (currentCount || 1) to prevent division by zero
      // queuePerConsumer = 10 / 1 = 10 (not 10 / 0)
      // This is over-utilized (10 > 2.0), should scale up
      const result = strategy.calculateTargetCount(0);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(baseOptions.maxConsumerCount);
    });

    it("should handle zero queue with zero consumers", () => {
      const metricsProcessor = createMetricsProcessor(0);
      const strategy = new AggressiveScalingStrategy({ ...baseOptions, metricsProcessor });

      // queuePerConsumer = 0 / 1 = 0
      // This is under-utilized (0 < 0.5), should scale down
      // But already at 0, so should return minConsumerCount
      const result = strategy.calculateTargetCount(0);
      expect(result).toBe(baseOptions.minConsumerCount);
    });
  });

  describe("Integration scenarios", () => {
    it("should handle gradual load increase with smooth strategy", () => {
      const metricsProcessor = createMetricsProcessor(2);
      const strategy = new SmoothScalingStrategy({ ...baseOptions, metricsProcessor });
      let currentCount = 2;

      // Gradual increase: 2 → 6 → 10 → 15
      const loads = [2, 6, 10, 15];
      const results = [];

      for (const load of loads) {
        // Update the processor with the new load
        metricsProcessor.addSample(load);
        metricsProcessor.processBatch();
        const target = strategy.calculateTargetCount(currentCount);
        results.push(target);
        currentCount = target;
      }

      // Should show gradual increase due to damping
      expect(results[0]).toBeLessThan(results[1]!);
      expect(results[1]).toBeLessThan(results[2]!);
      expect(results[2]).toBeLessThan(results[3]!);

      // But not immediate jumps due to damping
      expect(results[1]! - results[0]!).toBeLessThan(loads[1]! - loads[0]!);
    });

    it("should handle load spike with aggressive strategy", () => {
      let currentCount = 3;

      // Sudden spike from normal to critical
      const normalLoad = 3; // queuePerConsumer = 1.0 (optimal)
      const spikeLoad = 15; // queuePerConsumer = 5.0 (critical)

      const normalProcessor = createMetricsProcessor(normalLoad);
      const normalStrategy = new AggressiveScalingStrategy({
        ...baseOptions,
        metricsProcessor: normalProcessor,
      });
      const normalTarget = normalStrategy.calculateTargetCount(currentCount);
      expect(normalTarget).toBe(3); // Should maintain

      const spikeProcessor = createMetricsProcessor(spikeLoad);
      const spikeStrategy = new AggressiveScalingStrategy({
        ...baseOptions,
        metricsProcessor: spikeProcessor,
      });
      const spikeTarget = spikeStrategy.calculateTargetCount(currentCount);
      expect(spikeTarget).toBeGreaterThan(3); // Should scale up aggressively
    });
  });
});
