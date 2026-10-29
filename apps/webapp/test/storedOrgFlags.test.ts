import { describe, expect, it } from "vitest";
import {
  FEATURE_FLAG,
  ORG_LOCKED_FLAGS,
  ORG_LOCKED_FLAG_EFFECT,
  isUnchangedInvalidFlag,
  mergeOrgFeatureFlags,
  parseStoredOrgFlags,
  validatePartialFeatureFlags,
} from "~/v3/featureFlags";

describe("parseStoredOrgFlags", () => {
  it("matches validatePartialFeatureFlags for an all-valid blob", () => {
    const blob = {
      [FEATURE_FLAG.hasLogsPageAccess]: true,
      [FEATURE_FLAG.taskEventRepository]: "clickhouse",
      [FEATURE_FLAG.computeMigrationFreePercentage]: "40",
    };

    const expected = validatePartialFeatureFlags(blob);
    if (!expected.success) throw expected.error;

    expect(parseStoredOrgFlags(blob)).toEqual({
      valid: expected.data,
      invalid: {},
      unknownKeys: {},
    });
  });

  it("keeps the valid keys when one value is invalid", () => {
    const result = parseStoredOrgFlags({
      [FEATURE_FLAG.hasLogsPageAccess]: true,
      [FEATURE_FLAG.taskEventRepository]: "clickhouse",
      [FEATURE_FLAG.realtimeBackend]: "not-a-backend",
    });

    expect(result.valid).toEqual({
      [FEATURE_FLAG.hasLogsPageAccess]: true,
      [FEATURE_FLAG.taskEventRepository]: "clickhouse",
    });
    expect(result.invalid).toEqual({ [FEATURE_FLAG.realtimeBackend]: "not-a-backend" });
    expect(result.unknownKeys).toEqual({});
  });

  it("returns unknown keys with their raw values", () => {
    const result = parseStoredOrgFlags({
      someNewerFlag: { nested: 1 },
      [FEATURE_FLAG.hasQueryAccess]: true,
    });

    expect(result.valid).toEqual({ [FEATURE_FLAG.hasQueryAccess]: true });
    expect(result.invalid).toEqual({});
    expect(result.unknownKeys).toEqual({ someNewerFlag: { nested: 1 } });
  });

  it("treats inherited object keys as unknown, not as catalog flags", () => {
    const result = parseStoredOrgFlags(JSON.parse('{"toString": true}'));

    expect(result.unknownKeys).toEqual({ toString: true });
    expect(result.valid).toEqual({});
  });

  it.each([null, undefined, [], ["a"], "flags", 1])("returns nothing for %j", (raw) => {
    expect(parseStoredOrgFlags(raw)).toEqual({ valid: {}, invalid: {}, unknownKeys: {} });
  });
});

describe("ORG_LOCKED_FLAG_EFFECT", () => {
  it("classifies every org-locked flag and nothing else", () => {
    expect(Object.keys(ORG_LOCKED_FLAG_EFFECT).sort()).toEqual([...ORG_LOCKED_FLAGS].sort());
  });

  it("marks taskEventRepository as a live override", () => {
    expect(ORG_LOCKED_FLAG_EFFECT[FEATURE_FLAG.taskEventRepository]).toBe("live");
  });
});

describe("isUnchangedInvalidFlag", () => {
  const KEY = FEATURE_FLAG.workerQueueEnvironmentOverrides;
  const invalid = { [KEY]: { x: null } };

  it("is true while the draft still holds the stored invalid value", () => {
    expect(isUnchangedInvalidFlag(KEY, { [KEY]: { x: null } }, invalid)).toBe(true);
  });

  it("is false once the admin edits or unsets it", () => {
    expect(isUnchangedInvalidFlag(KEY, { [KEY]: { PRODUCTION: { compat: "any" } } }, invalid)).toBe(
      false
    );
    expect(isUnchangedInvalidFlag(KEY, {}, invalid)).toBe(false);
  });

  it("is false when nothing invalid is stored for the key", () => {
    expect(isUnchangedInvalidFlag(KEY, { [KEY]: { x: null } }, undefined)).toBe(false);
    expect(isUnchangedInvalidFlag(KEY, { [KEY]: { x: null } }, {})).toBe(false);
  });
});

describe("mergeOrgFeatureFlags", () => {
  const globalFlags = {
    [FEATURE_FLAG.hasLogsPageAccess]: false,
    [FEATURE_FLAG.hasQueryAccess]: false,
  };

  it("merges valid org overrides on top of global flags", () => {
    const result = mergeOrgFeatureFlags(globalFlags, {
      [FEATURE_FLAG.hasLogsPageAccess]: true,
    });
    expect(result).toEqual({
      [FEATURE_FLAG.hasLogsPageAccess]: true,
      [FEATURE_FLAG.hasQueryAccess]: false,
    });
  });

  it("preserves valid org flags when an invalid flag is present in stored org flags", () => {
    const result = mergeOrgFeatureFlags(globalFlags, {
      [FEATURE_FLAG.hasLogsPageAccess]: true,
      [FEATURE_FLAG.snapshotStoreMode]: "invalid-mode",
    });
    expect(result).toEqual({
      [FEATURE_FLAG.hasLogsPageAccess]: true,
      [FEATURE_FLAG.hasQueryAccess]: false,
    });
  });

  it("ignores unknown keys in stored org flags when merging", () => {
    const result = mergeOrgFeatureFlags(globalFlags, {
      [FEATURE_FLAG.hasLogsPageAccess]: true,
      unknownKey: "should-be-ignored",
    });
    expect(result).toEqual({
      [FEATURE_FLAG.hasLogsPageAccess]: true,
      [FEATURE_FLAG.hasQueryAccess]: false,
    });
  });

  it.each([null, undefined, "", 123, []])("returns global flags unchanged for %j", (raw) => {
    expect(mergeOrgFeatureFlags(globalFlags, raw)).toEqual(globalFlags);
  });
});
