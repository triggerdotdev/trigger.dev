// Production points at a Valkey/Redis CLUSTER. SCAN carries no key, so a cluster cannot route it:
// one connection iterates ONE node's keyspace and then returns a completed cursor. A single-client
// sweep would therefore report {scanned, expired, deleted, skipped} looking exactly like a clean
// pass, having examined roughly 1/N of the keyspace, and the rest would leak with nothing left to
// revisit it. Both sweep rules close unbounded leaks, and TRI-13453 gates the rollout dial on an
// OBSERVED sweep pass, so a false green here is the worst failure this component has.
//
// Everything the sweep does after the scan is key-addressed and a cluster client routes it without
// help, so the node list is the whole of the exposure. These tests pin that decision directly.
//
// There is no Redis-cluster container fixture in the repo (@internal/testcontainers ships slot
// arithmetic, not a cluster), so the cluster cases drive a real ioredis `Cluster` object that has
// never connected and assert which method the code reaches for. That is a test of our branch, not
// a simulation of Redis. A true multi-node integration test wants a cluster fixture, and the ticket
// building the cluster client is the one placed to add it.
import { describe, expect, it } from "vitest";
import { Cluster, Redis } from "@internal/redis";
import { containerTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { clientPrefixOf, scanTargetsOf, SnapshotOrphanSweeper } from "./snapshotOrphanSweeper.js";

/** An ioredis Cluster that is never connected. `lazyConnect` keeps the constructor from dialling. */
function offlineCluster(options?: { keyPrefix?: string }): Cluster {
  return new Cluster([{ host: "127.0.0.1", port: 7000 }], {
    lazyConnect: true,
    redisOptions: options?.keyPrefix ? { keyPrefix: options.keyPrefix } : undefined,
  });
}

describe("scanTargetsOf", () => {
  it("returns the one connection for a standalone client", () => {
    const client = new Redis({ lazyConnect: true, port: 65000 });
    try {
      expect(scanTargetsOf(client)).toEqual([client]);
    } finally {
      client.disconnect();
    }
  });

  it("returns every master for a cluster, and never a replica", async () => {
    const cluster = offlineCluster();
    const masters = [
      new Redis({ lazyConnect: true, port: 65001 }),
      new Redis({ lazyConnect: true, port: 65002 }),
      new Redis({ lazyConnect: true, port: 65003 }),
    ];
    const replica = new Redis({ lazyConnect: true, port: 65004 });

    const asked: string[] = [];
    // The assertion that matters: the sweep asks for "master" specifically. Asking for "all" would
    // scan replicas too and act twice on one keyspace.
    (cluster as unknown as { nodes: (role: string) => Redis[] }).nodes = (role: string) => {
      asked.push(role);
      return role === "master" ? masters : [...masters, replica];
    };

    expect(scanTargetsOf(cluster)).toEqual(masters);
    expect(asked).toEqual(["master"]);
    expect(scanTargetsOf(cluster)).not.toContain(replica);

    for (const client of [...masters, replica]) client.disconnect();
    cluster.disconnect();
  });

  it("resolves the node list per call, so a failover is picked up", () => {
    const cluster = offlineCluster();
    let generation = 0;
    (cluster as unknown as { nodes: () => Redis[] }).nodes = () => {
      generation += 1;
      return Array.from(
        { length: generation },
        (_v, i) => new Redis({ lazyConnect: true, port: 65100 + i })
      );
    };

    expect(scanTargetsOf(cluster)).toHaveLength(1);
    expect(scanTargetsOf(cluster)).toHaveLength(2);
    cluster.disconnect();
  });
});

describe("clientPrefixOf", () => {
  it("reads the top-level keyPrefix on a standalone client", () => {
    const client = new Redis({ lazyConnect: true, port: 65000, keyPrefix: "engine:" });
    try {
      expect(clientPrefixOf(client)).toBe("engine:");
    } finally {
      client.disconnect();
    }
  });

  it("reads the nested redisOptions.keyPrefix on a cluster", () => {
    // On a Cluster the prefix lives under redisOptions. Reading the top level yields "", every
    // SCAN MATCH then misses, and the pass reports a clean sweep of nothing.
    const cluster = offlineCluster({ keyPrefix: "engine:" });
    try {
      expect(clientPrefixOf(cluster)).toBe("engine:");
    } finally {
      cluster.disconnect();
    }
  });

  it("is empty when no prefix is configured, for either shape", () => {
    const client = new Redis({ lazyConnect: true, port: 65000 });
    const cluster = offlineCluster();
    try {
      expect(clientPrefixOf(client)).toBe("");
      expect(clientPrefixOf(cluster)).toBe("");
    } finally {
      client.disconnect();
      cluster.disconnect();
    }
  });
});

describe("SweepResult.nodes", () => {
  containerTest(
    "a standalone pass reports the one connection it covered",
    async ({ prisma, redisOptions }) => {
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const sweeper = new SnapshotOrphanSweeper({
        redisOptions,
        runStore,
        completedTtlMs: 72 * 60 * 60 * 1000,
      });

      try {
        const result = await sweeper.sweep({ dryRun: true });
        // Without this field a pass that covered one node of six is indistinguishable from a
        // complete one, which is exactly the false green the fan-out exists to prevent.
        expect(result.nodes).toBe(1);
      } finally {
        await sweeper.quit();
      }
    }
  );
});

describe("client ownership", () => {
  containerTest("quit() leaves a borrowed client open", async ({ prisma, redisOptions }) => {
    const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const client = new Redis(redisOptions);
    const sweeper = new SnapshotOrphanSweeper({
      client,
      runStore,
      completedTtlMs: 72 * 60 * 60 * 1000,
    });

    try {
      await sweeper.quit();
      // The store and the sweep can share one cluster client. If quit() closed a client it did not
      // open, the first component to shut down would take the other one's connection with it.
      await client.set(`ownership:${generateInternalId()}`, "1");
      expect(await client.ping()).toBe("PONG");
    } finally {
      client.disconnect();
    }
  });
});
