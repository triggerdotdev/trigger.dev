import { postgresTest } from "@internal/testcontainers";
import { generateRunOpsIdV2 } from "@trigger.dev/core/v3/isomorphic";
import { afterEach, describe, expect, vi } from "vitest";

// The flag and the store are built at import from the environment, so each case re-imports. Clients
// connect at import: every URL is the real Postgres, and local overrides are cleared.
async function load(url: string, env: Record<string, string | undefined>) {
  vi.stubEnv("DATABASE_URL", url);
  vi.stubEnv("DIRECT_URL", url);
  for (const name of [
    "CONTROL_PLANE_DATABASE_URL",
    "CONTROL_PLANE_DATABASE_READ_REPLICA_URL",
    "DATABASE_READ_REPLICA_URL",
    "RUN_OPS_DATABASE_READ_REPLICA_URL",
    "RUN_OPS_LEGACY_DATABASE_READ_REPLICA_URL",
    "RUN_OPS_SHARDS",
  ]) {
    vi.stubEnv(name, undefined);
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const { runStore, runStoreRoutesByShard } = await import("~/v3/runStore.server");
  const { runOpsSplitReadEnabled } = await import("~/db.server");
  // The class from the same fresh module graph as the store, as the route adapter checks it.
  const { UnknownShardKey } = await import("@internal/run-store");
  // The routing store refuses a look-up on a shard with no store; a single Postgres store finds no row.
  const lookup = await Promise.resolve()
    .then(() => runStore.findRun({ id: generateRunOpsIdV2("m") }))
    .then(
      (row) => (row === null ? "no row" : "row"),
      (error) => (error instanceof UnknownShardKey ? "unknown shard" : String(error))
    );
  return { runStoreRoutesByShard, runOpsSplitReadEnabled, lookup };
}

const bothUrls = (url: string) => ({
  RUN_OPS_DATABASE_URL: url,
  RUN_OPS_LEGACY_DATABASE_URL: url,
});

describe("runStoreRoutesByShard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    // The run-ops topology and the run store are process-wide singletons built from the environment.
    delete (globalThis as { __trigger_singletons?: unknown }).__trigger_singletons;
  });

  postgresTest("is false with no run-ops URLs", async ({ postgresContainer }) => {
    const result = await load(postgresContainer.getConnectionUri(), {
      RUN_OPS_DATABASE_URL: undefined,
      RUN_OPS_LEGACY_DATABASE_URL: undefined,
      RUN_OPS_SPLIT_ENABLED: "false",
    });
    expect(result).toEqual({
      runStoreRoutesByShard: false,
      runOpsSplitReadEnabled: false,
      lookup: "no row",
    });
  });

  postgresTest(
    "is true with both run-ops URLs and split reads off",
    async ({ postgresContainer }) => {
      const url = postgresContainer.getConnectionUri();
      const result = await load(url, { ...bothUrls(url), RUN_OPS_SPLIT_ENABLED: "false" });
      expect(result).toEqual({
        runStoreRoutesByShard: true,
        runOpsSplitReadEnabled: false,
        lookup: "unknown shard",
      });
    }
  );

  postgresTest(
    "is true with both run-ops URLs and split reads on",
    async ({ postgresContainer }) => {
      const url = postgresContainer.getConnectionUri();
      const result = await load(url, { ...bothUrls(url), RUN_OPS_SPLIT_ENABLED: "true" });
      expect(result).toEqual({
        runStoreRoutesByShard: true,
        runOpsSplitReadEnabled: true,
        lookup: "unknown shard",
      });
    }
  );
});
