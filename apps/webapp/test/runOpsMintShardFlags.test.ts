// The mint-shard flags carry two safety claims that only the catalog can enforce: a bad value is
// rejected at WRITE (so no unroutable key and no silently-unpinned environment can ever be
// stored), and each key is locked at the scope its resolver does not read. Pure, no containers.
import { describe, expect, it } from "vitest";
import {
  FEATURE_FLAG,
  FeatureFlagCatalog,
  GLOBAL_LOCKED_FLAGS,
  ORG_LOCKED_FLAGS,
  validateFeatureFlagValue,
} from "~/v3/featureFlags";

describe("runOpsMintShard — the per-org pin", () => {
  const key = FEATURE_FLAG.runOpsMintShard;

  it("accepts every legal shard key", () => {
    for (const c of "abcdefghijklmnopqrstuvwxyz0123456789") {
      expect(validateFeatureFlagValue(key, c).success).toBe(true);
    }
  });

  it('accepts "new", which holds an org on gen-1', () => {
    expect(validateFeatureFlagValue(key, "new").success).toBe(true);
  });

  it("rejects a value that could never be stamped into an id", () => {
    for (const bad of ["A", "ab", "", "-", "legacy", " a", "a,b"]) {
      expect(validateFeatureFlagValue(key, bad).success).toBe(false);
    }
  });
});

describe("runOpsMintShardEnvPins — the per-environment pins", () => {
  const key = FEATURE_FLAG.runOpsMintShardEnvPins;

  it("accepts a map of environment id to shard key", () => {
    expect(
      validateFeatureFlagValue(key, JSON.stringify({ env_1: "a", env_2: "new" })).success
    ).toBe(true);
    expect(validateFeatureFlagValue(key, "{}").success).toBe(true);
  });

  it("rejects a blob that is not JSON, so a typo cannot silently un-pin every environment", () => {
    for (const bad of ["{not json", "", "null", "[]", '"a"', "42"]) {
      expect(validateFeatureFlagValue(key, bad).success).toBe(false);
    }
  });

  it("rejects a map whose value is not a legal pin", () => {
    for (const bad of [{ env_1: "AB" }, { env_1: "legacy" }, { env_1: 1 }, { env_1: "" }]) {
      expect(validateFeatureFlagValue(key, JSON.stringify(bad)).success).toBe(false);
    }
  });
});

describe("runOpsMintShardSet — the active list", () => {
  const key = FEATURE_FLAG.runOpsMintShardSet;

  it("accepts an empty list and a CSV of legal keys", () => {
    expect(validateFeatureFlagValue(key, "").success).toBe(true);
    expect(validateFeatureFlagValue(key, "a").success).toBe(true);
    expect(validateFeatureFlagValue(key, "a,b, c").success).toBe(true);
  });

  it("rejects a CSV holding a key that cannot be routed", () => {
    for (const bad of ["A", "ab", "a,B", "a,legacy", "a,new", "a;b"]) {
      expect(validateFeatureFlagValue(key, bad).success).toBe(false);
    }
  });
});

describe("scope locks match what each resolver actually reads", () => {
  it("locks the pins globally, because the resolver reads them from the org blob only", () => {
    expect(GLOBAL_LOCKED_FLAGS).toContain(FEATURE_FLAG.runOpsMintShard);
    expect(GLOBAL_LOCKED_FLAGS).toContain(FEATURE_FLAG.runOpsMintShardEnvPins);
  });

  it("locks the list per-org, because it is deployment-wide", () => {
    expect(ORG_LOCKED_FLAGS).toContain(FEATURE_FLAG.runOpsMintShardSet);
    expect(ORG_LOCKED_FLAGS).toContain(FEATURE_FLAG.runOpsMintShardSetPrev);
    expect(ORG_LOCKED_FLAGS).toContain(FEATURE_FLAG.runOpsMintShardSetFlippedAt);
  });

  it("keeps the pins settable per-org, which is the canary lever", () => {
    expect(ORG_LOCKED_FLAGS).not.toContain(FEATURE_FLAG.runOpsMintShard);
    expect(ORG_LOCKED_FLAGS).not.toContain(FEATURE_FLAG.runOpsMintShardEnvPins);
  });

  it("registers every new key in the catalog, so the admin pages render it", () => {
    for (const key of [
      FEATURE_FLAG.runOpsMintShard,
      FEATURE_FLAG.runOpsMintShardEnvPins,
      FEATURE_FLAG.runOpsMintShardSet,
      FEATURE_FLAG.runOpsMintShardSetPrev,
      FEATURE_FLAG.runOpsMintShardSetFlippedAt,
    ]) {
      expect(FeatureFlagCatalog).toHaveProperty(key);
    }
  });
});
