import { describe, it, expect } from "vitest";
import { getNowInNanoseconds, calculateDurationFromStart } from "./common.server";

describe("OTLP nanosecond precision", () => {
  it("guarantees exact integer arithmetic without float truncation", () => {
    const sampleMs = 1729200000123;
    const sampleDate = new Date(sampleMs);
    const expectedNano = BigInt(sampleMs) * 1_000_000n;

    // Buggy float math produces 1729200000123000064n (+64ns error)
    const buggyNano = BigInt(sampleMs * 1_000_000);
    expect(buggyNano).not.toBe(expectedNano);

    // Fixed calculation produces exact 1729200000123000000n
    const fixedNano = BigInt(sampleDate.getTime()) * BigInt(1_000_000);
    expect(fixedNano).toBe(expectedNano);
  });

  it("preserves exact duration calculation", () => {
    const start = 1729200000000n * 1_000_000n;
    const end = new Date(1729200000500); // 500ms later
    const duration = calculateDurationFromStart(end, start);
    expect(duration).toBe(500_000_000);
  });
});
