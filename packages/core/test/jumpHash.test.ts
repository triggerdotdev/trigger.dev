import { jumpHash } from "../src/v3/serverOnly/index.js";

describe("jumpHash", () => {
  it("should hash a string to a number", () => {
    expect(jumpHash("test", 10)).toBe(5);
  });

  it("should hash different strings to numbers in range", () => {
    for (const key of ["a", "b", "c", "test", "trigger", "dev", "123", "!@#"]) {
      for (const buckets of [1, 2, 5, 10, 100, 1000]) {
        const result = jumpHash(key, buckets);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThan(buckets);
      }
    }
  });

  it("should return 0 for any key if buckets is 1", () => {
    expect(jumpHash("anything", 1)).toBe(0);
    expect(jumpHash("", 1)).toBe(0);
  });

  it("should handle empty string key", () => {
    expect(jumpHash("", 10)).toBeGreaterThanOrEqual(0);
    expect(jumpHash("", 10)).toBeLessThan(10);
  });

  it("should distribute keys evenly across buckets", () => {
    const buckets = 10;
    const numKeys = 10000;
    const counts = Array(buckets).fill(0);
    for (let i = 0; i < numKeys; i++) {
      const key = `key_${i}`;
      const bucket = jumpHash(key, buckets);
      counts[bucket]++;
    }
    const avg = numKeys / buckets;
    // No bucket should have less than half or more than double the average
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(avg * 0.5);
      expect(count).toBeLessThanOrEqual(avg * 2);
    }
  });

  it("should have minimal movement when increasing buckets by 1", () => {
    const numKeys = 1000;
    const buckets = 50;
    let moved = 0;
    for (let i = 0; i < numKeys; i++) {
      const key = `key_${i}`;
      const bucket1 = jumpHash(key, buckets);
      const bucket2 = jumpHash(key, buckets + 1);
      if (bucket1 !== bucket2) moved++;
    }
    // For jump consistent hash, about 1/(buckets+1) of keys should move
    const expectedMoved = numKeys / (buckets + 1);
    expect(moved).toBeGreaterThanOrEqual(expectedMoved * 0.5);
    expect(moved).toBeLessThanOrEqual(expectedMoved * 2);
  });

  it("should be deterministic for the same key and bucket count", () => {
    for (let i = 0; i < 100; i++) {
      const key = `key_${i}`;
      const buckets = 20;
      const result1 = jumpHash(key, buckets);
      const result2 = jumpHash(key, buckets);
      expect(result1).toBe(result2);
    }
  });

  it("should always return a value in [0, buckets-1]", () => {
    for (let i = 0; i < 100; i++) {
      const key = `key_${i}`;
      for (let buckets = 1; buckets < 50; buckets++) {
        const result = jumpHash(key, buckets);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThan(buckets);
      }
    }
  });
});
