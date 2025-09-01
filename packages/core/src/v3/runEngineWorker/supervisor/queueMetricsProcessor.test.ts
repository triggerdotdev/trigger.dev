import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueueMetricsProcessor } from "./queueMetricsProcessor.js";

describe("QueueMetricsProcessor", () => {
  let processor: QueueMetricsProcessor;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Constructor validation", () => {
    it("should throw error for invalid ewmaAlpha", () => {
      expect(() => new QueueMetricsProcessor({ ewmaAlpha: -0.1, batchWindowMs: 1000 })).toThrow(
        "ewmaAlpha must be between 0 and 1"
      );

      expect(() => new QueueMetricsProcessor({ ewmaAlpha: 1.1, batchWindowMs: 1000 })).toThrow(
        "ewmaAlpha must be between 0 and 1"
      );
    });

    it("should throw error for invalid batchWindowMs", () => {
      expect(() => new QueueMetricsProcessor({ ewmaAlpha: 0.3, batchWindowMs: 0 })).toThrow(
        "batchWindowMs must be positive"
      );

      expect(() => new QueueMetricsProcessor({ ewmaAlpha: 0.3, batchWindowMs: -100 })).toThrow(
        "batchWindowMs must be positive"
      );
    });

    it("should accept valid parameters", () => {
      expect(() => new QueueMetricsProcessor({ ewmaAlpha: 0, batchWindowMs: 1 })).not.toThrow();
      expect(() => new QueueMetricsProcessor({ ewmaAlpha: 1, batchWindowMs: 5000 })).not.toThrow();
    });
  });

  describe("Sample collection", () => {
    beforeEach(() => {
      processor = new QueueMetricsProcessor({ ewmaAlpha: 0.3, batchWindowMs: 1000 });
    });

    it("should collect samples without limit", () => {
      for (let i = 0; i < 100; i++) {
        processor.addSample(i);
      }

      expect(processor.getCurrentSampleCount()).toBe(100);
      expect(processor.getCurrentSamples()).toHaveLength(100);
    });

    it("should throw error for negative queue lengths", () => {
      expect(() => processor.addSample(-1)).toThrow("Queue length cannot be negative");
    });

    it("should accept zero queue length", () => {
      expect(() => processor.addSample(0)).not.toThrow();
      expect(processor.getCurrentSampleCount()).toBe(1);
    });
  });

  describe("Batch processing timing", () => {
    beforeEach(() => {
      processor = new QueueMetricsProcessor({ ewmaAlpha: 0.3, batchWindowMs: 1000 });
    });

    it("should not process batch before window expires", () => {
      processor.addSample(10, 1000);

      expect(processor.shouldProcessBatch(1500)).toBe(false); // 500ms later
      expect(processor.shouldProcessBatch(1999)).toBe(false); // 999ms later
    });

    it("should process batch when window expires", () => {
      processor.addSample(10, 1000);

      expect(processor.shouldProcessBatch(2000)).toBe(true); // 1000ms later
      expect(processor.shouldProcessBatch(2500)).toBe(true); // 1500ms later
    });

    it("should not process empty batch", () => {
      expect(processor.shouldProcessBatch(5000)).toBe(false);
    });
  });

  describe("EWMA calculation", () => {
    it("should initialize with first value", () => {
      processor = new QueueMetricsProcessor({ ewmaAlpha: 0.3, batchWindowMs: 1000 });

      processor.addSample(10);
      const result = processor.processBatch();

      expect(result).not.toBeNull();
      expect(result!.median).toBe(10);
      expect(result!.smoothedValue).toBe(10);
      expect(processor.getSmoothedValue()).toBe(10);
    });

    it("should apply EWMA formula correctly", () => {
      processor = new QueueMetricsProcessor({ ewmaAlpha: 0.3, batchWindowMs: 1000 });

      // First batch: smoothed = 10
      processor.addSample(10);
      processor.processBatch();
      expect(processor.getSmoothedValue()).toBe(10);

      // Second batch: smoothed = 0.3 * 20 + 0.7 * 10 = 6 + 7 = 13
      processor.addSample(20);
      processor.processBatch();
      expect(processor.getSmoothedValue()).toBe(13);

      // Third batch: smoothed = 0.3 * 5 + 0.7 * 13 = 1.5 + 9.1 = 10.6
      processor.addSample(5);
      processor.processBatch();
      expect(processor.getSmoothedValue()).toBe(10.6);
    });

    it("should test different alpha values", () => {
      // High alpha (0.8) - more responsive
      const highAlphaProcessor = new QueueMetricsProcessor({ ewmaAlpha: 0.8, batchWindowMs: 1000 });
      highAlphaProcessor.addSample(10);
      highAlphaProcessor.processBatch();
      highAlphaProcessor.addSample(20);
      highAlphaProcessor.processBatch();

      // Low alpha (0.1) - more smoothing
      const lowAlphaProcessor = new QueueMetricsProcessor({ ewmaAlpha: 0.1, batchWindowMs: 1000 });
      lowAlphaProcessor.addSample(10);
      lowAlphaProcessor.processBatch();
      lowAlphaProcessor.addSample(20);
      lowAlphaProcessor.processBatch();

      // High alpha should be closer to recent value (20)
      expect(highAlphaProcessor.getSmoothedValue()).toBeCloseTo(18); // 0.8 * 20 + 0.2 * 10 = 18
      // Low alpha should be closer to previous value (10)
      expect(lowAlphaProcessor.getSmoothedValue()).toBeCloseTo(11); // 0.1 * 20 + 0.9 * 10 = 11
    });
  });

  describe("Median filtering", () => {
    beforeEach(() => {
      processor = new QueueMetricsProcessor({ ewmaAlpha: 0.3, batchWindowMs: 1000 });
    });

    it("should calculate median of odd number of samples", () => {
      processor.addSample(1);
      processor.addSample(10);
      processor.addSample(5);

      const result = processor.processBatch();
      expect(result!.median).toBe(5);
    });

    it("should calculate median of even number of samples", () => {
      processor.addSample(1);
      processor.addSample(10);
      processor.addSample(5);
      processor.addSample(8);

      const result = processor.processBatch();
      // With even count, we take the lower middle value (index 1)
      // Sorted: [1, 5, 8, 10], median index = floor(4/2) = 2, so median = 8
      expect(result!.median).toBe(8);
    });

    it("should filter outliers using median", () => {
      // Add mostly low values with one outlier
      processor.addSample(5);
      processor.addSample(5);
      processor.addSample(5);
      processor.addSample(100); // outlier
      processor.addSample(5);

      const result = processor.processBatch();
      // Sorted: [5, 5, 5, 5, 100], median = 5 (filters out outlier)
      expect(result!.median).toBe(5);
    });
  });

  describe("Batch result", () => {
    beforeEach(() => {
      processor = new QueueMetricsProcessor({ ewmaAlpha: 0.3, batchWindowMs: 1000 });
    });

    it("should return comprehensive batch result", () => {
      processor.addSample(10);
      processor.addSample(20);
      processor.addSample(15);

      const result = processor.processBatch();

      expect(result).not.toBeNull();
      expect(result!.median).toBe(15);
      expect(result!.smoothedValue).toBe(15); // First batch
      expect(result!.sampleCount).toBe(3);
      expect(result!.samples).toEqual([10, 20, 15]);
    });

    it("should return null for empty batch", () => {
      const result = processor.processBatch();
      expect(result).toBeNull();
    });

    it("should clear samples after processing", () => {
      processor.addSample(10);
      processor.addSample(20);

      expect(processor.getCurrentSampleCount()).toBe(2);

      processor.processBatch();

      expect(processor.getCurrentSampleCount()).toBe(0);
      expect(processor.getCurrentSamples()).toHaveLength(0);
    });
  });

  describe("Reset functionality", () => {
    beforeEach(() => {
      processor = new QueueMetricsProcessor({ ewmaAlpha: 0.3, batchWindowMs: 1000 });
    });

    it("should reset all state", () => {
      processor.addSample(10);
      processor.processBatch();
      processor.addSample(20);

      expect(processor.getSmoothedValue()).toBe(10);
      expect(processor.getCurrentSampleCount()).toBe(1);

      processor.reset();

      expect(processor.getSmoothedValue()).toBe(0);
      expect(processor.getCurrentSampleCount()).toBe(0);
      expect(processor.getCurrentSamples()).toHaveLength(0);
    });

    it("should reinitialize correctly after reset", () => {
      // Process some data
      processor.addSample(10);
      processor.processBatch();
      processor.addSample(20);
      processor.processBatch();

      processor.reset();

      // Should initialize with first value again
      processor.addSample(30);
      const result = processor.processBatch();

      expect(result!.smoothedValue).toBe(30);
      expect(processor.getSmoothedValue()).toBe(30);
    });
  });

  describe("Configuration", () => {
    it("should return configuration", () => {
      processor = new QueueMetricsProcessor({ ewmaAlpha: 0.5, batchWindowMs: 2000 });

      const config = processor.getConfig();
      expect(config.ewmaAlpha).toBe(0.5);
      expect(config.batchWindowMs).toBe(2000);
    });
  });

  describe("Real-world simulation", () => {
    it("should handle high-frequency samples from multiple consumers", () => {
      processor = new QueueMetricsProcessor({ ewmaAlpha: 0.3, batchWindowMs: 1000 });

      // Simulate 40 consumers reporting queue lengths within 1 second
      const baseTime = 1000;
      for (let i = 0; i < 40; i++) {
        const queueLength = 100 - i * 2; // Queue decreasing as consumers work
        processor.addSample(queueLength, baseTime + i * 25); // Spread over 1 second
      }

      const result = processor.processBatch(baseTime + 1000);

      expect(result).not.toBeNull();
      expect(result!.sampleCount).toBe(40);
      // Median should be around middle values (queue lengths 60-80)
      expect(result!.median).toBeGreaterThanOrEqual(60);
      expect(result!.median).toBeLessThanOrEqual(80);
    });

    it("should demonstrate EWMA smoothing over time", () => {
      processor = new QueueMetricsProcessor({ ewmaAlpha: 0.3, batchWindowMs: 1000 });

      const results = [];

      // Simulate queue spike and recovery
      const scenarios = [
        { samples: [5, 5, 5], expected: 5 }, // Baseline
        { samples: [50, 50, 50], expected: 18.5 }, // Spike: 0.3 * 50 + 0.7 * 5 = 18.5
        { samples: [5, 5, 5], expected: 10.05 }, // Recovery: 0.3 * 5 + 0.7 * 18.5 = 14.45
      ];

      for (const scenario of scenarios) {
        for (const sample of scenario.samples) {
          processor.addSample(sample);
        }
        const result = processor.processBatch();
        results.push(result!.smoothedValue);
      }

      // Should show gradual change due to EWMA smoothing
      expect(results[0]).toBe(5); // Initial
      expect(results[1]).toBeCloseTo(18.5); // Spike response
      expect(results[2]).toBeCloseTo(14.45); // Gradual recovery
    });
  });
});
