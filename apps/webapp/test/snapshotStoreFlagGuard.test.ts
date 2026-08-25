import { describe, expect, it } from "vitest";
import { snapshotStoreFlagSaveError } from "~/v3/snapshotStoreFlagGuard.server";

describe("snapshotStoreFlagSaveError", () => {
  it("refuses a flip past off when no host is configured", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreMode: "dual-write" },
        { redisHostConfigured: false }
      )
    ).toMatch(/RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST/);
  });

  it("names the position it refused", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreMode: "redis-read" },
        { redisHostConfigured: false }
      )
    ).toMatch(/redis-read/);
  });

  it("allows a flip past off once the host is configured", () => {
    expect(
      snapshotStoreFlagSaveError({ snapshotStoreMode: "dual-write" }, { redisHostConfigured: true })
    ).toBeUndefined();
  });

  it("allows off with no host, because that is the default state", () => {
    expect(
      snapshotStoreFlagSaveError({ snapshotStoreMode: "off" }, { redisHostConfigured: false })
    ).toBeUndefined();
  });

  it("ignores a payload that does not mention the dial", () => {
    expect(
      snapshotStoreFlagSaveError({ runOpsMintKind: "cuid" }, { redisHostConfigured: false })
    ).toBeUndefined();
  });

  it("ignores a non-string dial value and leaves it to schema validation", () => {
    expect(
      snapshotStoreFlagSaveError({ snapshotStoreMode: 3 }, { redisHostConfigured: false })
    ).toBeUndefined();
  });
});
