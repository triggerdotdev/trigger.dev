import { describe, expect, it } from "vitest";
import {
  exceptDevEnvironments,
  filterOrphanedEnvironments,
  onlyDevEnvironments,
  sortEnvironments,
} from "~/utils/environmentSort";

describe("sortEnvironments", () => {
  it("orders by environment type first (dev, staging, preview, prod)", () => {
    const sorted = sortEnvironments([
      { type: "PRODUCTION" },
      { type: "PREVIEW" },
      { type: "DEVELOPMENT" },
      { type: "STAGING" },
    ]);

    expect(sorted.map((e) => e.type)).toEqual(["DEVELOPMENT", "STAGING", "PREVIEW", "PRODUCTION"]);
  });

  it("sorts same-type rows by lastActivity desc when both have it", () => {
    const older = new Date("2026-06-01T00:00:00Z");
    const newer = new Date("2026-06-20T00:00:00Z");

    const sorted = sortEnvironments([
      { type: "DEVELOPMENT", userName: "a", lastActivity: older },
      { type: "DEVELOPMENT", userName: "b", lastActivity: newer },
    ]);

    // Most recently active branch first.
    expect(sorted.map((e) => e.userName)).toEqual(["b", "a"]);
  });

  it("falls back to updatedAt desc when neither row has lastActivity", () => {
    const older = new Date("2026-06-01T00:00:00Z");
    const newer = new Date("2026-06-20T00:00:00Z");

    const sorted = sortEnvironments([
      { type: "DEVELOPMENT", userName: "a", updatedAt: older },
      { type: "DEVELOPMENT", userName: "b", updatedAt: newer },
    ]);

    // Most recently updated branch first.
    expect(sorted.map((e) => e.userName)).toEqual(["b", "a"]);
  });

  it("uses a row's lastActivity over its own stale updatedAt", () => {
    const staleUpdate = new Date("2026-06-01T00:00:00Z");
    const recentActivity = new Date("2026-06-26T00:00:00Z");
    const otherUpdate = new Date("2026-06-10T00:00:00Z");

    // 'a' has a stale updatedAt but recent dev activity; 'b' has only a (more
    // recent than a's update) updatedAt. If activity weren't preferred, a's
    // stale 06-01 would lose to b's 06-10; instead a's 06-26 activity wins.
    const sorted = sortEnvironments([
      { type: "DEVELOPMENT", userName: "b", updatedAt: otherUpdate },
      { type: "DEVELOPMENT", userName: "a", updatedAt: staleUpdate, lastActivity: recentActivity },
    ]);

    expect(sorted.map((e) => e.userName)).toEqual(["a", "b"]);
  });

  it("orders rows with any timestamp ahead of rows with none", () => {
    const sorted = sortEnvironments([
      { type: "DEVELOPMENT", userName: "no-timestamp" },
      { type: "DEVELOPMENT", userName: "has-update", updatedAt: new Date("2026-06-10T00:00:00Z") },
    ]);

    expect(sorted.map((e) => e.userName)).toEqual(["has-update", "no-timestamp"]);
  });

  it("falls back to username order when lastActivity is absent (the ZSET-missing case)", () => {
    // When the recency ZSET is missing/evicted, lastActivity is undefined for
    // every branch, and the list must still render in a stable order.
    const sorted = sortEnvironments([
      { type: "DEVELOPMENT", userName: "charlie" },
      { type: "DEVELOPMENT", userName: "alice" },
      { type: "DEVELOPMENT", userName: "bob" },
    ]);

    expect(sorted.map((e) => e.userName)).toEqual(["alice", "bob", "charlie"]);
  });
});

describe("filterOrphanedEnvironments", () => {
  it("drops DEVELOPMENT envs with no owning org member", () => {
    const result = filterOrphanedEnvironments([
      { type: "DEVELOPMENT", orgMemberId: "om_1" },
      { type: "DEVELOPMENT", orgMemberId: undefined },
      { type: "PRODUCTION" } as any,
    ]);

    expect(result).toEqual([{ type: "DEVELOPMENT", orgMemberId: "om_1" }, { type: "PRODUCTION" }]);
  });

  it("keeps DEVELOPMENT envs whose orgMember relation is loaded", () => {
    const result = filterOrphanedEnvironments([
      { type: "DEVELOPMENT", orgMember: { id: "om_1" } },
      { type: "DEVELOPMENT", orgMember: undefined } as any,
    ]);

    expect(result).toEqual([{ type: "DEVELOPMENT", orgMember: { id: "om_1" } }]);
  });

  it("never filters non-development environments", () => {
    const envs = [{ type: "PREVIEW" }, { type: "STAGING" }, { type: "PRODUCTION" }] as any[];
    expect(filterOrphanedEnvironments(envs)).toEqual(envs);
  });
});

describe("onlyDevEnvironments / exceptDevEnvironments", () => {
  const envs = [{ type: "DEVELOPMENT" }, { type: "PREVIEW" }, { type: "PRODUCTION" }] as const;

  it("partitions on the development type", () => {
    expect(onlyDevEnvironments([...envs])).toEqual([{ type: "DEVELOPMENT" }]);
    expect(exceptDevEnvironments([...envs])).toEqual([{ type: "PREVIEW" }, { type: "PRODUCTION" }]);
  });
});
