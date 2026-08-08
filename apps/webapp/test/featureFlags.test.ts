// flag() resolves a per-org override without paying for the global row: a valid override
// short-circuits the query, an invalid one still falls through to the global value.
// NEVER mocks the DB: real testcontainers Postgres FeatureFlag rows, with the findFirst
// call counted by a delegating wrapper around the real client.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import type { PrismaClientOrTransaction } from "~/db.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
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
