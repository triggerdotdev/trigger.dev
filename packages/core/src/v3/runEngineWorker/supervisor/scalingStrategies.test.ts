import { describe, it, expect } from "vitest";
import {
  ScalingContext,
  NoneScalingStrategy,
  SmoothScalingStrategy,
  AggressiveScalingStrategy,
} from "./scalingStrategies.js";
import { QueueMetricsProcessor } from "./queueMetricsProcessor.js";

describe("Scaling Strategies", () => {
  const baseContext: ScalingContext = {
    currentConsumerCount: 5,
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
    const strategy = new NoneScalingStrategy();

    it("should always return maxConsumerCount", () => {
      expect(strategy.calculateTargetCount(baseContext)).toBe(20);
      expect(strategy.calculateTargetCount({ ...baseContext, currentConsumerCount: 1 })).toBe(20);
      expect(strategy.calculateTargetCount({ ...baseContext, maxConsumerCount: 25 })).toBe(25);
    });

    it("should have correct name", () => {
      expect(strategy.name).toBe("none");
    });
  });

  describe("SmoothScalingStrategy", () => {
    it("should calculate target based on smoothed queue length", () => {
      const metricsProcessor = createMetricsProcessor(10); // smoothed value = 10
      const strategy = new SmoothScalingStrategy({ metricsProcessor });

      // With targetRatio=1.0, target consumers = ceil(10/1.0) = 10
      // With dampingFactor=0.7 and currentCount=5:
      // dampedTarget = 5 + (10 - 5) * 0.7 = 5 + 3.5 = 8.5 → 9
      const result = strategy.calculateTargetCount(baseContext);
      expect(result).toBe(9);
    });

    it("should apply damping factor correctly", () => {
      const metricsProcessor = createMetricsProcessor(20); // smoothed value = 20
      const strategy = new SmoothScalingStrategy({ metricsProcessor, dampingFactor: 0.5 }); // 50% damping

      // With targetRatio=1.0, target consumers = ceil(20/1.0) = 20
      // With dampingFactor=0.5 and currentCount=5:
      // dampedTarget = 5 + (20 - 5) * 0.5 = 5 + 7.5 = 12.5 → 13
      const result = strategy.calculateTargetCount(baseContext);
      expect(result).toBe(13);
    });

    it("should handle zero current count", () => {
      const metricsProcessor = createMetricsProcessor(5);
      const strategy = new SmoothScalingStrategy({ metricsProcessor });
      const context = { ...baseContext, currentConsumerCount: 0 };

      // Should use minConsumerCount when currentCount is 0
      const result = strategy.calculateTargetCount(context);
      expect(result).toBeGreaterThan(0);
    });

    it("should validate damping factor", () => {
      const metricsProcessor = createMetricsProcessor(10);
      expect(() => new SmoothScalingStrategy({ metricsProcessor, dampingFactor: -0.1 })).toThrow(
        "dampingFactor must be between 0 and 1"
      );
      expect(() => new SmoothScalingStrategy({ metricsProcessor, dampingFactor: 1.1 })).toThrow(
        "dampingFactor must be between 0 and 1"
      );
      expect(() => new SmoothScalingStrategy({ metricsProcessor, dampingFactor: 0 })).not.toThrow();
      expect(() => new SmoothScalingStrategy({ metricsProcessor, dampingFactor: 1 })).not.toThrow();
    });
  });

  describe("AggressiveScalingStrategy", () => {
    it("should scale down when under-utilized", () => {
      // queuePerConsumer = 2/5 = 0.4, scaleDownThreshold = 1.0 * 0.5 = 0.5
      // Under-utilized since 0.4 < 0.5
      const metricsProcessor = createMetricsProcessor(2);
      const strategy = new AggressiveScalingStrategy({ metricsProcessor });

      const result = strategy.calculateTargetCount(baseContext);
      expect(result).toBeLessThan(baseContext.currentConsumerCount);
      expect(result).toBeGreaterThanOrEqual(baseContext.minConsumerCount);
    });

    it("should maintain count when in optimal zone", () => {
      // queuePerConsumer = 5/5 = 1.0
      // Optimal zone: 0.5 < 1.0 < 2.0
      const metricsProcessor = createMetricsProcessor(5);
      const strategy = new AggressiveScalingStrategy({ metricsProcessor });

      const result = strategy.calculateTargetCount(baseContext);
      expect(result).toBe(baseContext.currentConsumerCount);
    });

    it("should scale up when over-utilized", () => {
      // queuePerConsumer = 15/5 = 3.0, scaleUpThreshold = 1.0 * 2.0 = 2.0
      // Over-utilized since 3.0 > 2.0
      const metricsProcessor = createMetricsProcessor(15);
      const strategy = new AggressiveScalingStrategy({ metricsProcessor });

      const result = strategy.calculateTargetCount(baseContext);
      expect(result).toBeGreaterThan(baseContext.currentConsumerCount);
      expect(result).toBeLessThanOrEqual(baseContext.maxConsumerCount);
    });

    it("should scale aggressively for critical load", () => {
      // queuePerConsumer = 25/5 = 5.0 (critical: 5x target ratio)
      const metricsProcessor = createMetricsProcessor(25);
      const strategy = new AggressiveScalingStrategy({ metricsProcessor });

      const result = strategy.calculateTargetCount(baseContext);
      // Should apply 50% scale factor: ceil(5 * 1.5) = 8
      // But capped by 50% max increment: 5 + ceil(5 * 0.5) = 5 + 3 = 8
      expect(result).toBe(8);
    });

    it("should respect max consumer count", () => {
      const context = { ...baseContext, maxConsumerCount: 6 };
      const metricsProcessor = createMetricsProcessor(50); // Very high load
      const strategy = new AggressiveScalingStrategy({ metricsProcessor });

      const result = strategy.calculateTargetCount(context);
      expect(result).toBeLessThanOrEqual(6);
    });

    it("should respect min consumer count", () => {
      const context = { ...baseContext, minConsumerCount: 3 };
      const metricsProcessor = createMetricsProcessor(0.1); // Very low load
      const strategy = new AggressiveScalingStrategy({ metricsProcessor });

      const result = strategy.calculateTargetCount(context);
      expect(result).toBeGreaterThanOrEqual(3);
    });

    it("should return thresholds", () => {
      const metricsProcessor = createMetricsProcessor(10);
      const strategy = new AggressiveScalingStrategy({ metricsProcessor });
      const thresholds = strategy.getThresholds(1.0);
      expect(thresholds).toEqual({
        scaleDownThreshold: 0.5,
        scaleUpThreshold: 2.0,
        criticalThreshold: 5.0,
        highThreshold: 3.0,
      });
    });
  });

  describe("Integration scenarios", () => {
    it("should handle gradual load increase with smooth strategy", () => {
      const metricsProcessor = createMetricsProcessor(2);
      const strategy = new SmoothScalingStrategy({ metricsProcessor });
      let context = { ...baseContext, currentConsumerCount: 2 };

      // Gradual increase: 2 → 6 → 10 → 15
      const loads = [2, 6, 10, 15];
      const results = [];

      for (const load of loads) {
        // Update the processor with the new load
        metricsProcessor.addSample(load);
        metricsProcessor.processBatch();
        const target = strategy.calculateTargetCount(context);
        results.push(target);
        context = { ...context, currentConsumerCount: target };
      }

      // Should show gradual increase due to damping
      expect(results[0]).toBeLessThan(results[1]!);
      expect(results[1]).toBeLessThan(results[2]!);
      expect(results[2]).toBeLessThan(results[3]!);

      // But not immediate jumps due to damping
      expect(results[1]! - results[0]!).toBeLessThan(loads[1]! - loads[0]!);
    });

    it("should handle load spike with aggressive strategy", () => {
      let context = { ...baseContext, currentConsumerCount: 3 };

      // Sudden spike from normal to critical
      const normalLoad = 3; // queuePerConsumer = 1.0 (optimal)
      const spikeLoad = 15; // queuePerConsumer = 5.0 (critical)

      const normalProcessor = createMetricsProcessor(normalLoad);
      const normalStrategy = new AggressiveScalingStrategy({ metricsProcessor: normalProcessor });
      const normalTarget = normalStrategy.calculateTargetCount(context);
      expect(normalTarget).toBe(3); // Should maintain

      const spikeProcessor = createMetricsProcessor(spikeLoad);
      const spikeStrategy = new AggressiveScalingStrategy({ metricsProcessor: spikeProcessor });
      const spikeTarget = spikeStrategy.calculateTargetCount(context);
      expect(spikeTarget).toBeGreaterThan(3); // Should scale up aggressively
    });
  });
});
