import { describe, expect, it } from "vitest";
import {
  ExponentialBackoffRetry,
  FixedDelayRetry,
  LinearBackoffRetry,
  NoRetry,
  ImmediateRetry,
  CustomRetry,
} from "../retry.js";

describe("RetryStrategy", () => {
  describe("ExponentialBackoffRetry", () => {
    it("should return increasing delays", () => {
      const strategy = new ExponentialBackoffRetry({
        maxAttempts: 5,
        factor: 2,
        minTimeoutInMs: 100,
        maxTimeoutInMs: 10000,
        randomize: false,
      });

      const delay1 = strategy.getNextDelay(1);
      const delay2 = strategy.getNextDelay(2);
      const delay3 = strategy.getNextDelay(3);

      // Delays should increase
      expect(delay1).not.toBeNull();
      expect(delay2).not.toBeNull();
      expect(delay3).not.toBeNull();
      expect(delay2!).toBeGreaterThan(delay1!);
      expect(delay3!).toBeGreaterThan(delay2!);
    });

    it("should return null when max attempts reached", () => {
      const strategy = new ExponentialBackoffRetry({ maxAttempts: 3 });

      expect(strategy.getNextDelay(1)).not.toBeNull();
      expect(strategy.getNextDelay(2)).not.toBeNull();
      expect(strategy.getNextDelay(3)).toBeNull();
    });

    it("should have correct maxAttempts", () => {
      const strategy = new ExponentialBackoffRetry({ maxAttempts: 7 });
      expect(strategy.maxAttempts).toBe(7);
    });
  });

  describe("FixedDelayRetry", () => {
    it("should return same delay for all attempts", () => {
      const strategy = new FixedDelayRetry({ maxAttempts: 5, delayMs: 500 });

      expect(strategy.getNextDelay(1)).toBe(500);
      expect(strategy.getNextDelay(2)).toBe(500);
      expect(strategy.getNextDelay(3)).toBe(500);
      expect(strategy.getNextDelay(4)).toBe(500);
    });

    it("should return null when max attempts reached", () => {
      const strategy = new FixedDelayRetry({ maxAttempts: 3, delayMs: 500 });

      expect(strategy.getNextDelay(1)).toBe(500);
      expect(strategy.getNextDelay(2)).toBe(500);
      expect(strategy.getNextDelay(3)).toBeNull();
    });
  });

  describe("LinearBackoffRetry", () => {
    it("should return linearly increasing delays", () => {
      const strategy = new LinearBackoffRetry({
        maxAttempts: 5,
        baseDelayMs: 100,
      });

      expect(strategy.getNextDelay(1)).toBe(100);
      expect(strategy.getNextDelay(2)).toBe(200);
      expect(strategy.getNextDelay(3)).toBe(300);
      expect(strategy.getNextDelay(4)).toBe(400);
    });

    it("should cap at maxDelayMs", () => {
      const strategy = new LinearBackoffRetry({
        maxAttempts: 10,
        baseDelayMs: 100,
        maxDelayMs: 250,
      });

      expect(strategy.getNextDelay(1)).toBe(100);
      expect(strategy.getNextDelay(2)).toBe(200);
      expect(strategy.getNextDelay(3)).toBe(250);
      expect(strategy.getNextDelay(5)).toBe(250);
    });

    it("should return null when max attempts reached", () => {
      const strategy = new LinearBackoffRetry({
        maxAttempts: 3,
        baseDelayMs: 100,
      });

      expect(strategy.getNextDelay(3)).toBeNull();
    });
  });

  describe("NoRetry", () => {
    it("should always return null", () => {
      const strategy = new NoRetry();

      expect(strategy.getNextDelay(1)).toBeNull();
      expect(strategy.getNextDelay(0)).toBeNull();
    });

    it("should have maxAttempts of 1", () => {
      const strategy = new NoRetry();
      expect(strategy.maxAttempts).toBe(1);
    });
  });

  describe("ImmediateRetry", () => {
    it("should return 0 delay for all attempts", () => {
      const strategy = new ImmediateRetry(5);

      expect(strategy.getNextDelay(1)).toBe(0);
      expect(strategy.getNextDelay(2)).toBe(0);
      expect(strategy.getNextDelay(4)).toBe(0);
    });

    it("should return null when max attempts reached", () => {
      const strategy = new ImmediateRetry(3);

      expect(strategy.getNextDelay(3)).toBeNull();
    });
  });

  describe("CustomRetry", () => {
    it("should use custom calculation function", () => {
      const strategy = new CustomRetry({
        maxAttempts: 5,
        calculateDelay: (attempt) => attempt * attempt * 100,
      });

      expect(strategy.getNextDelay(1)).toBe(100);
      expect(strategy.getNextDelay(2)).toBe(400);
      expect(strategy.getNextDelay(3)).toBe(900);
      expect(strategy.getNextDelay(4)).toBe(1600);
    });

    it("should pass error to calculation function", () => {
      const errors: Error[] = [];
      const strategy = new CustomRetry({
        maxAttempts: 5,
        calculateDelay: (_attempt, error) => {
          if (error) errors.push(error);
          return 100;
        },
      });

      const testError = new Error("test error");
      strategy.getNextDelay(1, testError);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(testError);
    });

    it("should return null when max attempts reached", () => {
      const strategy = new CustomRetry({
        maxAttempts: 3,
        calculateDelay: () => 100,
      });

      expect(strategy.getNextDelay(3)).toBeNull();
    });

    it("should allow custom function to return null for DLQ", () => {
      const strategy = new CustomRetry({
        maxAttempts: 5,
        calculateDelay: (attempt) => (attempt === 2 ? null : 100),
      });

      expect(strategy.getNextDelay(1)).toBe(100);
      expect(strategy.getNextDelay(2)).toBeNull(); // Custom function says DLQ
    });
  });
});
