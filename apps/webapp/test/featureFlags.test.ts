// flag() resolves a per-org override without paying for the global row: a valid override
// short-circuits the query, an invalid one still falls through to the global value.
// NEVER mocks the DB: real testcontainers Postgres FeatureFlag rows, with the findFirst
// call counted by a delegating wrapper around the real client.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClientOrTransaction } from "~/db.server";
import {
  FEATURE_FLAG,
  hasUnreadableTurnEvalsOverride,
  validatePartialFeatureFlags,
} from "~/v3/featureFlags";
import { makeFlag, makeSetFlag } from "~/v3/featureFlags.server";

vi.setConfig({ testTimeout: 60_000 });

const KEY = FEATURE_FLAG.dashboardAgentTurnEvalsEnabled;

function countingClient(prisma: PrismaClient) {
  const calls = { findFirst: 0 };
  const client = {
    featureFlag: {
      findFirst: (args: unknown) => {
        calls.findFirst++;
        return (prisma.featureFlag.findFirst as (a: unknown) => unknown)(args);
      },
    },
  } as unknown as PrismaClientOrTransaction;

  return { client, calls };
}

describe("flag() override resolution", () => {
  postgresTest(
    "a valid `false` override wins without querying the global row",
    async ({ prisma }) => {
      await makeSetFlag(prisma)({ key: KEY, value: true });
      const { client, calls } = countingClient(prisma);

      const result = await makeFlag(client)({
        key: KEY,
        defaultValue: true,
        overrides: { [KEY]: false },
      });

      expect(result).toBe(false);
      expect(calls.findFirst).toBe(0);
    }
  );

  postgresTest(
    "a valid `true` override wins without querying the global row",
    async ({ prisma }) => {
      await makeSetFlag(prisma)({ key: KEY, value: false });
      const { client, calls } = countingClient(prisma);

      const result = await makeFlag(client)({
        key: KEY,
        defaultValue: false,
        overrides: { [KEY]: true },
      });

      expect(result).toBe(true);
      expect(calls.findFirst).toBe(0);
    }
  );

  postgresTest(
    "an override that fails the schema falls through to the global value",
    async ({ prisma }) => {
      await makeSetFlag(prisma)({ key: KEY, value: true });
      const { client, calls } = countingClient(prisma);

      const result = await makeFlag(client)({
        key: KEY,
        defaultValue: false,
        overrides: { [KEY]: "yes please" },
      });

      expect(result).toBe(true);
      expect(calls.findFirst).toBe(1);
    }
  );

  postgresTest("no override still queries the global row", async ({ prisma }) => {
    await makeSetFlag(prisma)({ key: KEY, value: true });
    const { client, calls } = countingClient(prisma);

    const result = await makeFlag(client)({
      key: KEY,
      defaultValue: false,
      overrides: {},
    });

    expect(result).toBe(true);
    expect(calls.findFirst).toBe(1);
  });
});

// The per-org snapshot dial ladders through the same positions as the global dial, so an org
// can be soaked at redis-read and redis-only, not just off and dual-write.
describe("snapshotStoreOrgMode ladder on the org save path", () => {
  const ORG_KEY = FEATURE_FLAG.snapshotStoreOrgMode;

  it("accepts every ladder position an org may be soaked at", () => {
    for (const value of ["off", "dual-write", "redis-read", "redis-only"]) {
      const parsed = validatePartialFeatureFlags({ [ORG_KEY]: value });
      expect(parsed.success, value).toBe(true);
    }
  });

  it("still rejects a bogus position", () => {
    expect(validatePartialFeatureFlags({ [ORG_KEY]: "redis-write" }).success).toBe(false);
  });
});

// The cohort dial map is a single global flag: orgId -> dial. The catalog must accept a well-formed
// map and reject one carrying a value outside the dial ladder.
describe("snapshotStoreOrgDials catalog", () => {
  const DIALS_KEY = FEATURE_FLAG.snapshotStoreOrgDials;

  it("parses a valid dial map", () => {
    const parsed = validatePartialFeatureFlags({
      [DIALS_KEY]: { org_a: "redis-only", org_b: "off" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a map with a bad dial value", () => {
    const parsed = validatePartialFeatureFlags({ [DIALS_KEY]: { org_a: "nope" } });
    expect(parsed.success).toBe(false);
  });
});

// The fall-through above is right for an entitlement and wrong for consent: judging sends the
// turn to a third-party model, so the eval flag refuses on an override it cannot read.
describe("hasUnreadableTurnEvalsOverride", () => {
  it("is false when the org has no opinion", () => {
    expect(hasUnreadableTurnEvalsOverride({})).toBe(false);
    expect(hasUnreadableTurnEvalsOverride(null)).toBe(false);
    expect(hasUnreadableTurnEvalsOverride([])).toBe(false);
    expect(hasUnreadableTurnEvalsOverride({ somethingElse: "nonsense" })).toBe(false);
  });

  it("is false for a real boolean, either way", () => {
    expect(hasUnreadableTurnEvalsOverride({ [KEY]: false })).toBe(false);
    expect(hasUnreadableTurnEvalsOverride({ [KEY]: true })).toBe(false);
  });

  // The dangerous one: `flag()` would drop "false" and hand back the global default, which is on.
  it("is true for a stringified boolean or any other garbage", () => {
    expect(hasUnreadableTurnEvalsOverride({ [KEY]: "false" })).toBe(true);
    expect(hasUnreadableTurnEvalsOverride({ [KEY]: "true" })).toBe(true);
    expect(hasUnreadableTurnEvalsOverride({ [KEY]: 0 })).toBe(true);
    expect(hasUnreadableTurnEvalsOverride({ [KEY]: null })).toBe(true);
  });
});
