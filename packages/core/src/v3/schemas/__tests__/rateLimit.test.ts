import { describe, it, expect } from "vitest";
import { QueueRateLimitConfigSchema, DurationStringSchema } from "../schemas.js";

describe("DurationStringSchema", () => {
  it("validates milliseconds", () => {
    expect(DurationStringSchema.safeParse("100ms").success).toBe(true);
    expect(DurationStringSchema.safeParse("1500ms").success).toBe(true);
  });

  it("validates seconds", () => {
    expect(DurationStringSchema.safeParse("1s").success).toBe(true);
    expect(DurationStringSchema.safeParse("30s").success).toBe(true);
    expect(DurationStringSchema.safeParse("1.5s").success).toBe(true);
  });

  it("validates minutes", () => {
    expect(DurationStringSchema.safeParse("1m").success).toBe(true);
    expect(DurationStringSchema.safeParse("60m").success).toBe(true);
  });

  it("validates hours", () => {
    expect(DurationStringSchema.safeParse("1h").success).toBe(true);
    expect(DurationStringSchema.safeParse("24h").success).toBe(true);
  });

  it("validates days", () => {
    expect(DurationStringSchema.safeParse("1d").success).toBe(true);
    expect(DurationStringSchema.safeParse("7d").success).toBe(true);
  });

  it("rejects invalid formats", () => {
    expect(DurationStringSchema.safeParse("invalid").success).toBe(false);
    expect(DurationStringSchema.safeParse("1x").success).toBe(false);
    expect(DurationStringSchema.safeParse("").success).toBe(false);
    expect(DurationStringSchema.safeParse("ms").success).toBe(false);
    expect(DurationStringSchema.safeParse("10").success).toBe(false);
    expect(DurationStringSchema.safeParse("-1s").success).toBe(false);
  });
});

describe("QueueRateLimitConfigSchema", () => {
  it("parses valid config with all fields", () => {
    const result = QueueRateLimitConfigSchema.safeParse({
      limit: 100,
      period: "1m",
      burst: 20,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(100);
      expect(result.data.period).toBe("1m");
      expect(result.data.burst).toBe(20);
    }
  });

  it("parses config without optional burst", () => {
    const result = QueueRateLimitConfigSchema.safeParse({
      limit: 10,
      period: "1s",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
      expect(result.data.period).toBe("1s");
      expect(result.data.burst).toBeUndefined();
    }
  });

  it("accepts various period formats", () => {
    expect(QueueRateLimitConfigSchema.safeParse({ limit: 10, period: "100ms" }).success).toBe(true);
    expect(QueueRateLimitConfigSchema.safeParse({ limit: 10, period: "30s" }).success).toBe(true);
    expect(QueueRateLimitConfigSchema.safeParse({ limit: 10, period: "5m" }).success).toBe(true);
    expect(QueueRateLimitConfigSchema.safeParse({ limit: 10, period: "1h" }).success).toBe(true);
    expect(QueueRateLimitConfigSchema.safeParse({ limit: 10, period: "1d" }).success).toBe(true);
  });

  it("rejects invalid period formats", () => {
    expect(QueueRateLimitConfigSchema.safeParse({ limit: 10, period: "1x" }).success).toBe(false);
    expect(QueueRateLimitConfigSchema.safeParse({ limit: 10, period: "invalid" }).success).toBe(
      false
    );
    expect(QueueRateLimitConfigSchema.safeParse({ limit: 10, period: "" }).success).toBe(false);
  });

  it("requires positive limit", () => {
    expect(QueueRateLimitConfigSchema.safeParse({ limit: 0, period: "1s" }).success).toBe(false);
    expect(QueueRateLimitConfigSchema.safeParse({ limit: -1, period: "1s" }).success).toBe(false);
  });

  it("requires limit to be an integer", () => {
    expect(QueueRateLimitConfigSchema.safeParse({ limit: 10.5, period: "1s" }).success).toBe(false);
  });

  it("requires burst to be a positive integer when provided", () => {
    expect(QueueRateLimitConfigSchema.safeParse({ limit: 10, period: "1s", burst: 0 }).success).toBe(
      false
    );
    expect(
      QueueRateLimitConfigSchema.safeParse({ limit: 10, period: "1s", burst: -1 }).success
    ).toBe(false);
    expect(
      QueueRateLimitConfigSchema.safeParse({ limit: 10, period: "1s", burst: 5.5 }).success
    ).toBe(false);
    expect(QueueRateLimitConfigSchema.safeParse({ limit: 10, period: "1s", burst: 5 }).success).toBe(
      true
    );
  });

  it("rejects missing required fields", () => {
    expect(QueueRateLimitConfigSchema.safeParse({ limit: 10 }).success).toBe(false);
    expect(QueueRateLimitConfigSchema.safeParse({ period: "1s" }).success).toBe(false);
    expect(QueueRateLimitConfigSchema.safeParse({}).success).toBe(false);
  });
});

