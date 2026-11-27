// flag() resolves a per-org override without paying for the global row: a valid override
// short-circuits the query, an invalid one still falls through to the global value.
// NEVER mocks the DB: real testcontainers Postgres FeatureFlag rows, with the findFirst
// call counted by a delegating wrapper around the real client.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, it, vi } from "vitest";
import type * as DbServerModule from "~/db.server";
import type { PrismaClientOrTransaction } from "~/db.server";
import {
  FEATURE_FLAG,
  FeatureFlagCatalog,
  GLOBAL_LOCKED_FLAGS,
  ORG_LOCKED_FLAGS,
  hasUnreadableTurnEvalsOverride,
  parseStoredOrgFlags,
} from "~/v3/featureFlags";
import { flags, makeFlag, makeSetFlag } from "~/v3/featureFlags.server";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

// `flags` is built on the app's default client: forward it to the current test's database.
vi.mock("~/db.server", async (importOriginal) => {
  const actual = await importOriginal<typeof DbServerModule>();
  const client = new Proxy(
    {},
    {
      get(_target, prop) {
        const value = (db.client as any)[prop];
        return typeof value === "function" ? value.bind(db.client) : value;
      },
    }
  );
  return { ...actual, prisma: client };
});

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

describe("flags()", () => {
  // Catches: flags() returning a stored key outside the catalogue, or a value its schema rejects.
  postgresTest("returns only catalogue keys whose stored value parses", async ({ prisma }) => {
    db.client = prisma;
    await prisma.featureFlag.createMany({
      data: [
        { key: FEATURE_FLAG.waitpointStoreEnabled, value: true },
        { key: "notInTheCatalogue", value: true },
        { key: FEATURE_FLAG.realtimeBackend, value: "not-a-backend" },
      ],
    });

    expect(await flags()).toEqual({ [FEATURE_FLAG.waitpointStoreEnabled]: true });
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

describe("deployNowEnabled flag", () => {
  it("is registered as a strict boolean flag", () => {
    expect(FEATURE_FLAG.deployNowEnabled).toBe("deployNowEnabled");
    const schema = FeatureFlagCatalog[FEATURE_FLAG.deployNowEnabled];
    expect(schema.safeParse(true).success).toBe(true);
    // strict boolean: the string "false" must NOT coerce to a boolean
    expect(schema.safeParse("false").success).toBe(false);
  });
});

describe("checkpointStoreEnabled flag", () => {
  // Catches: a coercing schema that turns the string "false" on, or the key unknown or locked.
  it("is registered as a strict boolean flag, settable per organization and globally", () => {
    expect(FEATURE_FLAG.checkpointStoreEnabled).toBe("checkpointStoreEnabled");
    const schema = FeatureFlagCatalog[FEATURE_FLAG.checkpointStoreEnabled];
    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse(false).success).toBe(true);
    expect(schema.safeParse("false").success).toBe(false);
    expect(schema.safeParse("true").success).toBe(false);
    const stored = parseStoredOrgFlags({ checkpointStoreEnabled: true });
    expect(stored.valid).toEqual({ checkpointStoreEnabled: true });
    expect(stored.unknownKeys).not.toHaveProperty("checkpointStoreEnabled");
    expect(GLOBAL_LOCKED_FLAGS).not.toContain(FEATURE_FLAG.checkpointStoreEnabled);
    expect(ORG_LOCKED_FLAGS).not.toContain(FEATURE_FLAG.checkpointStoreEnabled);
  });
});
