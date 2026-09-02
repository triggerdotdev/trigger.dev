import { describe, expect, it } from "vitest";
import { isSnapshotStoreConfigured } from "~/v3/snapshotStoreConfigured.server";

describe("isSnapshotStoreConfigured", () => {
  it("is false when no Redis host is set (feature merged but inert)", () => {
    expect(isSnapshotStoreConfigured(undefined)).toBe(false);
    expect(isSnapshotStoreConfigured("")).toBe(false);
  });

  it("is true once a Redis host is set", () => {
    expect(isSnapshotStoreConfigured("snap-redis.internal")).toBe(true);
  });
});
