// The store saved on a new run (and the org-level store the logs page uses) is the effective one:
// with the reroute on, the legacy "clickhouse" value never comes out of resolution.
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { makeFlag } from "~/v3/featureFlags.server";
import { resolveEventStore } from "~/v3/eventRepository/resolveEventStore.server";

vi.setConfig({ testTimeout: 60_000 });

describe("resolveEventStore", () => {
  postgresTest(
    "stores clickhouse_v2 for a child of a run stored as clickhouse",
    async ({ prisma }) => {
      const store = await resolveEventStore({
        parentStore: "clickhouse",
        featureFlags: undefined,
        flag: makeFlag(prisma),
        defaultStore: "clickhouse_v2",
        v1RerouteEnabled: true,
      });

      expect(store).toBe("clickhouse_v2");
    }
  );

  postgresTest("stores clickhouse_v2 for an org pinned to clickhouse", async ({ prisma }) => {
    await prisma.featureFlag.create({
      data: { key: "taskEventRepository", value: "clickhouse_v2" },
    });

    const store = await resolveEventStore({
      featureFlags: { taskEventRepository: "clickhouse" },
      flag: makeFlag(prisma),
      defaultStore: "clickhouse_v2",
      v1RerouteEnabled: true,
    });

    expect(store).toBe("clickhouse_v2");
  });

  postgresTest(
    "stores clickhouse_v2 when the global flag and env default say clickhouse",
    async ({ prisma }) => {
      await prisma.featureFlag.create({
        data: { key: "taskEventRepository", value: "clickhouse" },
      });
      const flag = makeFlag(prisma);

      expect(
        await resolveEventStore({
          featureFlags: undefined,
          flag,
          defaultStore: "clickhouse_v2",
          v1RerouteEnabled: true,
        })
      ).toBe("clickhouse_v2");

      await prisma.featureFlag.deleteMany({ where: { key: "taskEventRepository" } });

      expect(
        await resolveEventStore({
          featureFlags: undefined,
          flag,
          defaultStore: "clickhouse",
          v1RerouteEnabled: true,
        })
      ).toBe("clickhouse_v2");
    }
  );

  postgresTest("keeps clickhouse when the reroute is off", async ({ prisma }) => {
    const flag = makeFlag(prisma);

    expect(
      await resolveEventStore({
        parentStore: "clickhouse",
        featureFlags: undefined,
        flag,
        defaultStore: "clickhouse_v2",
        v1RerouteEnabled: false,
      })
    ).toBe("clickhouse");

    expect(
      await resolveEventStore({
        featureFlags: { taskEventRepository: "clickhouse" },
        flag,
        defaultStore: "clickhouse_v2",
        v1RerouteEnabled: false,
      })
    ).toBe("clickhouse");
  });

  postgresTest("flags an org override that still selects the retired store", async ({ prisma }) => {
    const onLegacyFlagStore = vi.fn();

    const store = await resolveEventStore({
      featureFlags: { taskEventRepository: "clickhouse" },
      flag: makeFlag(prisma),
      defaultStore: "postgres",
      v1RerouteEnabled: true,
      onLegacyFlagStore,
    });

    expect(store).toBe("clickhouse_v2");
    expect(onLegacyFlagStore).toHaveBeenCalledOnce();
  });

  postgresTest(
    "leaves inherited stores and the env default to the startup warning",
    async ({ prisma }) => {
      const onLegacyFlagStore = vi.fn();
      const flag = makeFlag(prisma);

      await resolveEventStore({
        parentStore: "clickhouse",
        featureFlags: undefined,
        flag,
        defaultStore: "postgres",
        v1RerouteEnabled: true,
        onLegacyFlagStore,
      });

      await resolveEventStore({
        featureFlags: undefined,
        flag,
        defaultStore: "clickhouse",
        v1RerouteEnabled: true,
        onLegacyFlagStore,
      });

      expect(onLegacyFlagStore).not.toHaveBeenCalled();
    }
  );
});
