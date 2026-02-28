import { describe, it, expect, beforeEach } from "vitest";
import {
  matchesPattern,
  compilePattern,
  clearPatternCache,
} from "../../../src/v3/events/patternMatcher.js";

describe("matchesPattern", () => {
  beforeEach(() => {
    clearPatternCache();
  });

  describe("exact match (no wildcards)", () => {
    it("matches identical slug", () => {
      expect(matchesPattern("order.created", "order.created")).toBe(true);
    });

    it("rejects different slug", () => {
      expect(matchesPattern("order.updated", "order.created")).toBe(false);
    });

    it("matches single-segment slug", () => {
      expect(matchesPattern("created", "created")).toBe(true);
    });
  });

  describe("* (single-segment wildcard)", () => {
    it("order.* matches order.created", () => {
      expect(matchesPattern("order.created", "order.*")).toBe(true);
    });

    it("order.* matches order.updated", () => {
      expect(matchesPattern("order.updated", "order.*")).toBe(true);
    });

    it("order.* does NOT match order.status.changed", () => {
      expect(matchesPattern("order.status.changed", "order.*")).toBe(false);
    });

    it("order.* does NOT match order (fewer segments)", () => {
      expect(matchesPattern("order", "order.*")).toBe(false);
    });

    it("*.created matches order.created", () => {
      expect(matchesPattern("order.created", "*.created")).toBe(true);
    });

    it("*.created matches user.created", () => {
      expect(matchesPattern("user.created", "*.created")).toBe(true);
    });

    it("*.created does NOT match org.user.created", () => {
      expect(matchesPattern("org.user.created", "*.created")).toBe(false);
    });

    it("*.* matches any two-segment slug", () => {
      expect(matchesPattern("order.created", "*.*")).toBe(true);
      expect(matchesPattern("user.deleted", "*.*")).toBe(true);
    });

    it("*.* does NOT match single segment", () => {
      expect(matchesPattern("created", "*.*")).toBe(false);
    });

    it("*.* does NOT match three segments", () => {
      expect(matchesPattern("order.status.changed", "*.*")).toBe(false);
    });
  });

  describe("# (multi-segment wildcard)", () => {
    it("order.# matches order.created (1 segment)", () => {
      expect(matchesPattern("order.created", "order.#")).toBe(true);
    });

    it("order.# matches order.status.changed (2 segments)", () => {
      expect(matchesPattern("order.status.changed", "order.#")).toBe(true);
    });

    it("order.# matches order (0 segments)", () => {
      expect(matchesPattern("order", "order.#")).toBe(true);
    });

    it("order.# does NOT match user.created", () => {
      expect(matchesPattern("user.created", "order.#")).toBe(false);
    });

    it("#.created matches order.created", () => {
      expect(matchesPattern("order.created", "#.created")).toBe(true);
    });

    it("#.created matches org.user.created", () => {
      expect(matchesPattern("org.user.created", "#.created")).toBe(true);
    });

    it("#.created matches created (0 prefix segments)", () => {
      expect(matchesPattern("created", "#.created")).toBe(true);
    });

    it("#.created does NOT match order.updated", () => {
      expect(matchesPattern("order.updated", "#.created")).toBe(false);
    });

    it("# matches anything", () => {
      expect(matchesPattern("anything", "#")).toBe(true);
      expect(matchesPattern("a.b.c.d", "#")).toBe(true);
    });
  });

  describe("combined wildcards", () => {
    it("*.*.created matches order.item.created", () => {
      expect(matchesPattern("order.item.created", "*.*.created")).toBe(true);
    });

    it("*.*.created does NOT match order.created", () => {
      expect(matchesPattern("order.created", "*.*.created")).toBe(false);
    });

    it("*.# matches anything with at least one segment", () => {
      // * matches one segment, # matches zero or more
      // so *.# matches any slug with >= 1 segment
      expect(matchesPattern("order", "*.#")).toBe(true);
      expect(matchesPattern("order.created", "*.#")).toBe(true);
      expect(matchesPattern("order.status.changed", "*.#")).toBe(true);
    });

    it("#.*.created matches order.item.created", () => {
      expect(matchesPattern("order.item.created", "#.*.created")).toBe(true);
    });

    it("#.*.created matches item.created", () => {
      expect(matchesPattern("item.created", "#.*.created")).toBe(true);
    });
  });
});

describe("compilePattern", () => {
  beforeEach(() => {
    clearPatternCache();
  });

  it("returns a reusable predicate", () => {
    const matches = compilePattern("order.*");
    expect(matches("order.created")).toBe(true);
    expect(matches("order.updated")).toBe(true);
    expect(matches("user.created")).toBe(false);
  });

  it("caches compiled patterns", () => {
    const fn1 = compilePattern("order.*");
    const fn2 = compilePattern("order.*");
    expect(fn1).toBe(fn2);
  });

  it("clearPatternCache invalidates cache", () => {
    const fn1 = compilePattern("order.*");
    clearPatternCache();
    const fn2 = compilePattern("order.*");
    expect(fn1).not.toBe(fn2);
  });
});
