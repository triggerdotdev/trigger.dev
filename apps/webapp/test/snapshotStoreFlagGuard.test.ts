import { describe, expect, it } from "vitest";
import {
  globalOnlySnapshotStoreFlagError,
  snapshotStoreFlagSaveError,
} from "~/v3/snapshotStoreFlagGuard.server";
import {
  FeatureFlagCatalog,
  FEATURE_FLAG,
  GLOBAL_LOCKED_FLAGS,
  ORG_LOCKED_FLAGS,
} from "~/v3/featureFlags";

describe("snapshotStoreFlagSaveError", () => {
  it("refuses a flip past off when no host is configured", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreMode: "dual-write" },
        { redisHostConfigured: false, everEnabled: true }
      )
    ).toMatch(/RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST/);
  });

  it("names the position it refused", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreMode: "redis-read" },
        { redisHostConfigured: false, everEnabled: true }
      )
    ).toMatch(/redis-read/);
  });

  it("allows a flip past off once the host is configured", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreMode: "dual-write" },
        { redisHostConfigured: true, everEnabled: true }
      )
    ).toBeUndefined();
  });

  it("allows off with no host, because that is the default state", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreMode: "off" },
        { redisHostConfigured: false, everEnabled: true }
      )
    ).toBeUndefined();
  });

  it("ignores a payload that does not mention the dial", () => {
    expect(
      snapshotStoreFlagSaveError(
        { runOpsMintKind: "cuid" },
        { redisHostConfigured: false, everEnabled: true }
      )
    ).toBeUndefined();
  });

  it("ignores a non-string dial value and leaves it to schema validation", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreMode: 3 },
        { redisHostConfigured: false, everEnabled: true }
      )
    ).toBeUndefined();
  });

  it("refuses a per-organisation flip past off when no host is configured", () => {
    // Same silence as the global key: without a connection the store is never constructed.
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreOrgMode: "dual-write" },
        { redisHostConfigured: false, everEnabled: true }
      )
    ).toMatch(/RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST/);
  });

  it("allows a per-organisation off with no host", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreOrgMode: "off" },
        { redisHostConfigured: false, everEnabled: true }
      )
    ).toBeUndefined();
  });

  it("refuses a per-organisation redis-read when no host is configured", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreOrgMode: "redis-read" },
        { redisHostConfigured: false, everEnabled: true }
      )
    ).toMatch(/RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST/);
  });

  it("refuses a per-organisation redis-only when no host is configured", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreOrgMode: "redis-only" },
        { redisHostConfigured: false, everEnabled: true }
      )
    ).toMatch(/RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST/);
  });

  it("allows a per-organisation redis-read once host and latch are set", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreOrgMode: "redis-read" },
        { redisHostConfigured: true, everEnabled: true }
      )
    ).toBeUndefined();
  });

  it("allows a per-organisation redis-only once host and latch are set", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreOrgMode: "redis-only" },
        { redisHostConfigured: true, everEnabled: true }
      )
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

describe("the global page and the save guard agree", () => {
  it("locks every flag the global save path refuses", () => {
    // A flag the guard rejects but the page leaves editable renders a control whose only outcome is
    // a 400. The convention above GLOBAL_LOCKED_FLAGS states this; the assertion enforces it.
    for (const key of [FEATURE_FLAG.snapshotStoreOrgMode] as const) {
      expect(globalOnlySnapshotStoreFlagError({ [key]: "dual-write" })).toBeDefined();
      expect(GLOBAL_LOCKED_FLAGS).toContain(key);
    }
  });

  it("leaves the deployment-wide dial editable on the global page", () => {
    expect(globalOnlySnapshotStoreFlagError({ snapshotStoreMode: "dual-write" })).toBeUndefined();
    expect(GLOBAL_LOCKED_FLAGS).not.toContain(FEATURE_FLAG.snapshotStoreMode);
  });
});

describe("the residency latch", () => {
  it("refuses to enable the deployment dial before the latch is set", () => {
    // Ordering matters and must be impossible to get wrong. Transitions skip Redis entirely while
    // the latch is unset, so a run born after the dial moved but before the latch landed would be
    // resident with its transitions skipped, and its head would freeze. Latch first, always.
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreMode: "dual-write" },
        { redisHostConfigured: true, everEnabled: false }
      )
    ).toMatch(/snapshotStoreEverEnabled/);
  });

  it("refuses to enable a per-organisation override before the latch is set", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreOrgMode: "dual-write" },
        { redisHostConfigured: true, everEnabled: false }
      )
    ).toMatch(/snapshotStoreEverEnabled/);
  });

  it("allows enabling once the latch is set", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreMode: "dual-write" },
        { redisHostConfigured: true, everEnabled: true }
      )
    ).toBeUndefined();
  });

  it("never blocks a move back to off, whatever the latch says", () => {
    // Turning it down must never be gated. That is the rollback path.
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreMode: "off" },
        { redisHostConfigured: true, everEnabled: false }
      )
    ).toBeUndefined();
  });

  it("does not block setting the latch itself", () => {
    expect(
      snapshotStoreFlagSaveError(
        { snapshotStoreEverEnabled: true },
        { redisHostConfigured: true, everEnabled: false }
      )
    ).toBeUndefined();
  });

  it("is a deployment-wide flag, and takes only a real boolean", () => {
    expect(FeatureFlagCatalog.snapshotStoreEverEnabled.safeParse(true).success).toBe(true);
    expect(FeatureFlagCatalog.snapshotStoreEverEnabled.safeParse("true").success).toBe(false);
    expect(ORG_LOCKED_FLAGS).toContain("snapshotStoreEverEnabled");
  });
});
