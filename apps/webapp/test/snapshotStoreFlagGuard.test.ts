import { describe, expect, it } from "vitest";
import {
  globalOnlySnapshotStoreFlagError,
  snapshotStoreFlagSaveError,
} from "~/v3/snapshotStoreFlagGuard.server";

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

  it("refuses a per-organisation flip past off when no host is configured", () => {
    // Same silence as the global key: without a connection the store is never constructed.
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreOrgMode: "dual-write" },
        { redisHostConfigured: false }
      )
    ).toMatch(/RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST/);
  });

  it("allows a per-organisation off with no host", () => {
    expect(
      snapshotStoreFlagSaveError({ snapshotStoreOrgMode: "off" }, { redisHostConfigured: false })
    ).toBeUndefined();
  });
});

describe("globalOnlySnapshotStoreFlagError", () => {
  it("refuses the per-organisation key on a global save", () => {
    // Nothing reads it from the global row, so a value saved there is an inert control.
    expect(globalOnlySnapshotStoreFlagError({ snapshotStoreOrgMode: "dual-write" })).toMatch(
      /per-organisation only/
    );
  });

  it("allows the global key", () => {
    expect(globalOnlySnapshotStoreFlagError({ snapshotStoreMode: "dual-write" })).toBeUndefined();
  });

  it("ignores unrelated payloads", () => {
    expect(globalOnlySnapshotStoreFlagError({ runOpsMintKind: "cuid" })).toBeUndefined();
  });
});
