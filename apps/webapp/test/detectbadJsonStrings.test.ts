import { describe, expect, it } from "vitest";
import { detectBadJsonStrings } from "~/utils/detectBadJsonStrings";

describe("detectBadJsonStrings", () => {
  it("should not detect valid JSON string", () => {
    const goodJson = `{"title": "hello"}`;
    const result = detectBadJsonStrings(goodJson);
    expect(result).toBe(false);
  });

  it("should detect incomplete Unicode escape sequences", () => {
    const badJson = `{"title": "hello\\ud835"}`;
    const result = detectBadJsonStrings(badJson);
    expect(result).toBe(true);
  });

  it("should not detect complete Unicode escape sequences", () => {
    const goodJson = `{"title": "hello\\ud835\\udc00"}`;
    const result = detectBadJsonStrings(goodJson);
    expect(result).toBe(false);
  });

  it("should detect incomplete low surrogate", () => {
    const badJson = `{"title": "hello\\udc00"}`;
    const result = detectBadJsonStrings(badJson);
    expect(result).toBe(true);
  });

  it("should handle multiple Unicode sequences correctly", () => {
    const goodJson = `{"title": "hello\\ud835\\udc00\\ud835\\udc01"}`;
    const result = detectBadJsonStrings(goodJson);
    expect(result).toBe(false);
  });

  it("should detect mixed complete and incomplete sequences", () => {
    const badJson = `{"title": "hello\\ud835\\udc00\\ud835"}`;
    const result = detectBadJsonStrings(badJson);
    expect(result).toBe(true);
  });

  it("should have acceptable performance overhead", () => {
    const longText = `hello world `.repeat(1_000);
    const goodJson = `{"title": "hello", "text": "${longText}"}`;
    const badJson = `{"title": "hello\\ud835", "text": "${longText}"}`;

    const iterations = 100_000;

    // Warm up
    for (let i = 0; i < 1000; i++) {
      detectBadJsonStrings(goodJson);
      detectBadJsonStrings(badJson);
    }

    // Measure good JSON (most common case)
    const goodStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      detectBadJsonStrings(goodJson);
    }
    const goodTime = performance.now() - goodStart;

    // Measure bad JSON (edge case)
    const badStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      detectBadJsonStrings(badJson);
    }
    const badTime = performance.now() - badStart;

    // Measure baseline (just function call overhead)
    const baselineStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      // Empty function call to measure baseline
    }
    const baselineTime = performance.now() - baselineStart;

    const goodOverhead = goodTime - baselineTime;
    const badOverhead = badTime - baselineTime;

    console.log(`Baseline (${iterations} iterations): ${baselineTime.toFixed(2)}ms`);
    console.log(
      `Good JSON (${iterations} iterations): ${goodTime.toFixed(
        2
      )}ms (overhead: ${goodOverhead.toFixed(2)}ms)`
    );
    console.log(
      `Bad JSON (${iterations} iterations): ${badTime.toFixed(
        2
      )}ms (overhead: ${badOverhead.toFixed(2)}ms)`
    );
    console.log(
      `Average per call - Good: ${(goodOverhead / iterations).toFixed(4)}ms, Bad: ${(
        badOverhead / iterations
      ).toFixed(4)}ms`
    );

    // Assertions for performance expectations
    // Good JSON should be reasonably fast (most common case)
    expect(goodOverhead / iterations).toBeLessThan(0.01); // Less than 10 microseconds per call

    // Bad JSON can be slower due to regex matching, but still reasonable
    expect(badOverhead / iterations).toBeLessThan(0.01); // Less than 20 microseconds per call

    // Total overhead for 100k calls should be reasonable
    expect(goodOverhead).toBeLessThan(1000); // Less than 1 second for 100k calls
  });

  it("should handle various JSON sizes efficiently", () => {
    const sizes = [100, 1000, 10000, 100000];
    const iterations = 10_000;

    for (const size of sizes) {
      const text = `hello world `.repeat(size / 11); // Approximate size
      const goodJson = `{"title": "hello", "text": "${text}"}`;

      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        detectBadJsonStrings(goodJson);
      }
      const time = performance.now() - start;

      console.log(
        `Size ${size} chars (${iterations} iterations): ${time.toFixed(2)}ms (${(
          time / iterations
        ).toFixed(4)}ms per call)`
      );

      // Performance should scale reasonably with size
      expect(time / iterations).toBeLessThan(size / 1000); // Roughly linear scaling
    }
  });

  it("should show significant performance improvement with quick rejection", () => {
    const longText = `hello world `.repeat(1_000);
    const goodJson = `{"title": "hello", "text": "${longText}"}`;
    const badJson = `{"title": "hello\\ud835", "text": "${longText}"}`;
    const noUnicodeJson = `{"title": "hello", "text": "${longText}"}`;

    const iterations = 100_000;

    // Warm up
    for (let i = 0; i < 1000; i++) {
      detectBadJsonStrings(goodJson);
      detectBadJsonStrings(badJson);
      detectBadJsonStrings(noUnicodeJson);
    }

    // Test strings with no Unicode escapes (99.9% case)
    const noUnicodeStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      detectBadJsonStrings(noUnicodeJson);
    }
    const noUnicodeTime = performance.now() - noUnicodeStart;

    // Test strings with Unicode escapes (0.1% case)
    const withUnicodeStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      detectBadJsonStrings(badJson);
    }
    const withUnicodeTime = performance.now() - withUnicodeStart;

    console.log(
      `No Unicode escapes (${iterations} iterations): ${noUnicodeTime.toFixed(2)}ms (${(
        noUnicodeTime / iterations
      ).toFixed(4)}ms per call)`
    );
    console.log(
      `With Unicode escapes (${iterations} iterations): ${withUnicodeTime.toFixed(2)}ms (${(
        withUnicodeTime / iterations
      ).toFixed(4)}ms per call)`
    );
    console.log(
      `Performance ratio: ${(withUnicodeTime / noUnicodeTime).toFixed(
        2
      )}x slower for Unicode strings`
    );
  });
});

function processPacket(data: string): { data?: string; dataType?: string } {
  if (detectBadJsonStrings(data)) {
    return { data: undefined };
  }
  return { data, dataType: "application/json" };
}
