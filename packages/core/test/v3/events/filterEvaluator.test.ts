import { describe, it, expect, beforeEach } from "vitest";
import {
  compileFilter,
  evaluateFilter,
  invalidateFilterCache,
  clearFilterCache,
} from "../../../src/v3/events/filterEvaluator.js";
import type { EventFilter } from "../../../src/v3/schemas/eventFilter.js";

describe("evaluateFilter", () => {
  it("matches string equality", () => {
    const filter: EventFilter = { status: ["active"] };
    expect(evaluateFilter({ status: "active" }, filter)).toBe(true);
    expect(evaluateFilter({ status: "inactive" }, filter)).toBe(false);
  });

  it("matches number equality", () => {
    const filter: EventFilter = { count: [5] };
    expect(evaluateFilter({ count: 5 }, filter)).toBe(true);
    expect(evaluateFilter({ count: 3 }, filter)).toBe(false);
  });

  it("matches boolean equality", () => {
    const filter: EventFilter = { enabled: [true] };
    expect(evaluateFilter({ enabled: true }, filter)).toBe(true);
    expect(evaluateFilter({ enabled: false }, filter)).toBe(false);
  });

  it("matches multiple values (OR)", () => {
    const filter: EventFilter = { status: ["active", "pending"] };
    expect(evaluateFilter({ status: "active" }, filter)).toBe(true);
    expect(evaluateFilter({ status: "pending" }, filter)).toBe(true);
    expect(evaluateFilter({ status: "archived" }, filter)).toBe(false);
  });

  it("matches nested objects", () => {
    const filter: EventFilter = {
      order: {
        status: ["paid"],
      },
    };
    expect(evaluateFilter({ order: { status: "paid" } }, filter)).toBe(true);
    expect(evaluateFilter({ order: { status: "pending" } }, filter)).toBe(false);
  });

  it("matches $gt operator", () => {
    const filter: EventFilter = { amount: [{ $gt: 100 }] };
    expect(evaluateFilter({ amount: 150 }, filter)).toBe(true);
    expect(evaluateFilter({ amount: 50 }, filter)).toBe(false);
    expect(evaluateFilter({ amount: 100 }, filter)).toBe(false);
  });

  it("matches $gte operator", () => {
    const filter: EventFilter = { amount: [{ $gte: 100 }] };
    expect(evaluateFilter({ amount: 100 }, filter)).toBe(true);
    expect(evaluateFilter({ amount: 99 }, filter)).toBe(false);
  });

  it("matches $lt operator", () => {
    const filter: EventFilter = { amount: [{ $lt: 100 }] };
    expect(evaluateFilter({ amount: 50 }, filter)).toBe(true);
    expect(evaluateFilter({ amount: 100 }, filter)).toBe(false);
  });

  it("matches $lte operator", () => {
    const filter: EventFilter = { amount: [{ $lte: 100 }] };
    expect(evaluateFilter({ amount: 100 }, filter)).toBe(true);
    expect(evaluateFilter({ amount: 101 }, filter)).toBe(false);
  });

  it("matches $between operator", () => {
    const filter: EventFilter = { score: [{ $between: [10, 20] }] };
    expect(evaluateFilter({ score: 15 }, filter)).toBe(true);
    expect(evaluateFilter({ score: 10 }, filter)).toBe(true);
    expect(evaluateFilter({ score: 20 }, filter)).toBe(true);
    expect(evaluateFilter({ score: 9 }, filter)).toBe(false);
    expect(evaluateFilter({ score: 21 }, filter)).toBe(false);
  });

  it("matches $startsWith operator", () => {
    const filter: EventFilter = { name: [{ $startsWith: "Jo" }] };
    expect(evaluateFilter({ name: "John" }, filter)).toBe(true);
    expect(evaluateFilter({ name: "Jane" }, filter)).toBe(false);
  });

  it("matches $endsWith operator", () => {
    const filter: EventFilter = { email: [{ $endsWith: "@test.com" }] };
    expect(evaluateFilter({ email: "user@test.com" }, filter)).toBe(true);
    expect(evaluateFilter({ email: "user@other.com" }, filter)).toBe(false);
  });

  it("matches $ignoreCaseEquals operator", () => {
    const filter: EventFilter = { status: [{ $ignoreCaseEquals: "active" }] };
    expect(evaluateFilter({ status: "Active" }, filter)).toBe(true);
    expect(evaluateFilter({ status: "ACTIVE" }, filter)).toBe(true);
    expect(evaluateFilter({ status: "inactive" }, filter)).toBe(false);
  });

  it("matches $exists operator", () => {
    const existsFilter: EventFilter = { email: [{ $exists: true }] };
    expect(evaluateFilter({ email: "user@test.com" }, existsFilter)).toBe(true);
    expect(evaluateFilter({}, existsFilter)).toBe(false);

    const notExistsFilter: EventFilter = { deleted: [{ $exists: false }] };
    expect(evaluateFilter({}, notExistsFilter)).toBe(true);
    expect(evaluateFilter({ deleted: true }, notExistsFilter)).toBe(false);
  });

  it("matches $isNull operator", () => {
    const isNullFilter: EventFilter = { deletedAt: [{ $isNull: true }] };
    expect(evaluateFilter({ deletedAt: null }, isNullFilter)).toBe(true);
    expect(evaluateFilter({ deletedAt: "2024-01-01" }, isNullFilter)).toBe(false);

    const notNullFilter: EventFilter = { email: [{ $isNull: false }] };
    expect(evaluateFilter({ email: "test@test.com" }, notNullFilter)).toBe(true);
    expect(evaluateFilter({ email: null }, notNullFilter)).toBe(false);
  });

  it("matches $anythingBut operator", () => {
    const filter: EventFilter = { status: [{ $anythingBut: "deleted" }] };
    expect(evaluateFilter({ status: "active" }, filter)).toBe(true);
    expect(evaluateFilter({ status: "deleted" }, filter)).toBe(false);
  });

  it("matches $anythingBut with array", () => {
    const filter: EventFilter = { status: [{ $anythingBut: ["deleted", "archived"] }] };
    expect(evaluateFilter({ status: "active" }, filter)).toBe(true);
    expect(evaluateFilter({ status: "deleted" }, filter)).toBe(false);
    expect(evaluateFilter({ status: "archived" }, filter)).toBe(false);
  });

  it("matches $includes operator", () => {
    const filter: EventFilter = { tags: [{ $includes: "urgent" }] };
    expect(evaluateFilter({ tags: ["urgent", "important"] }, filter)).toBe(true);
    expect(evaluateFilter({ tags: ["normal"] }, filter)).toBe(false);
  });

  it("matches $not operator", () => {
    const filter: EventFilter = { status: [{ $not: "deleted" }] };
    expect(evaluateFilter({ status: "active" }, filter)).toBe(true);
    expect(evaluateFilter({ status: "deleted" }, filter)).toBe(false);
  });

  it("matches multiple conditions on different fields (AND)", () => {
    const filter: EventFilter = {
      status: ["active"],
      amount: [{ $gt: 100 }],
    };
    expect(evaluateFilter({ status: "active", amount: 200 }, filter)).toBe(true);
    expect(evaluateFilter({ status: "active", amount: 50 }, filter)).toBe(false);
    expect(evaluateFilter({ status: "inactive", amount: 200 }, filter)).toBe(false);
  });

  it("handles empty filter (matches everything)", () => {
    const filter: EventFilter = {};
    expect(evaluateFilter({ any: "thing" }, filter)).toBe(true);
    expect(evaluateFilter({}, filter)).toBe(true);
  });

  it("handles null/undefined payload with empty filter", () => {
    const filter: EventFilter = {};
    expect(evaluateFilter(null, filter)).toBe(true);
    expect(evaluateFilter(undefined, filter)).toBe(true);
  });

  it("handles null/undefined payload with non-empty filter", () => {
    const filter: EventFilter = { status: ["active"] };
    expect(evaluateFilter(null, filter)).toBe(false);
    expect(evaluateFilter(undefined, filter)).toBe(false);
  });
});

describe("compileFilter", () => {
  beforeEach(() => {
    clearFilterCache();
  });

  it("returns a function that evaluates the filter", () => {
    const filter: EventFilter = { status: ["active"] };
    const fn = compileFilter(filter);
    expect(fn({ status: "active" })).toBe(true);
    expect(fn({ status: "inactive" })).toBe(false);
  });

  it("caches compiled filters by key", () => {
    const filter: EventFilter = { status: ["active"] };
    const fn1 = compileFilter(filter, "sub_123");
    const fn2 = compileFilter(filter, "sub_123");
    expect(fn1).toBe(fn2); // Same reference
  });

  it("different keys produce different cache entries", () => {
    const filter1: EventFilter = { status: ["active"] };
    const filter2: EventFilter = { status: ["inactive"] };
    const fn1 = compileFilter(filter1, "sub_1");
    const fn2 = compileFilter(filter2, "sub_2");
    expect(fn1).not.toBe(fn2);
    expect(fn1({ status: "active" })).toBe(true);
    expect(fn2({ status: "inactive" })).toBe(true);
  });

  it("invalidateFilterCache removes a specific entry", () => {
    const filter: EventFilter = { status: ["active"] };
    const fn1 = compileFilter(filter, "sub_123");
    invalidateFilterCache("sub_123");
    const fn2 = compileFilter(filter, "sub_123");
    expect(fn1).not.toBe(fn2); // New reference after invalidation
  });

  it("clearFilterCache removes all entries", () => {
    const filter: EventFilter = { status: ["active"] };
    const fn1 = compileFilter(filter, "sub_1");
    const fn2 = compileFilter(filter, "sub_2");
    clearFilterCache();
    const fn3 = compileFilter(filter, "sub_1");
    expect(fn1).not.toBe(fn3);
  });
});
