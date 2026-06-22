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

    expect(sorted.map((e) => e.type)).toEqual([
      "DEVELOPMENT",
      "STAGING",
      "PREVIEW",
      "PRODUCTION",
    ]);
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

    expect(result).toEqual([
      { type: "DEVELOPMENT", orgMemberId: "om_1" },
      { type: "PRODUCTION" },
    ]);
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
    expect(exceptDevEnvironments([...envs])).toEqual([
      { type: "PREVIEW" },
      { type: "PRODUCTION" },
    ]);
  });
});
