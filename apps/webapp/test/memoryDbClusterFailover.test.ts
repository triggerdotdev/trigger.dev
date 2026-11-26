import { describe, expect, test, vi } from "vitest";
import { createRedisClusterClient, type Cluster } from "@internal/redis";
import { protocolMarkerKey, snapshotKeys, type SnapshotEntryInput } from "@internal/run-store";
import { hasLocalRedisServer, slotOf, startLocalRedisCluster } from "@internal/testcontainers";
import {
  createSnapshotConnection,
  snapshotClusterOptions,
} from "~/v3/utils/snapshotStoreConnection.server";
import {
  createWaitpointStoreConnection,
  waitpointClusterOptions,
} from "~/v3/utils/waitpointStoreConnection.server";

vi.unmock("ioredis");

type ClusterNode = { id: string; port: number; flags: string[]; masterId: string; slots: string[] };

function parseClusterNodes(output: string): ClusterNode[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, address, flags, masterId, , , , , ...slots] = line.split(" ");
      return {
        id: id!,
        port: Number(address!.split("@")[0]!.split(":")[1]),
        flags: flags!.split(","),
        masterId: masterId!,
        slots,
      };
    });
}

function ownsSlot(node: ClusterNode, slot: number) {
  return node.slots.some((range) => {
    const [start, end] = range.split("-").map(Number);
    return slot >= start! && slot <= (end ?? start!);
  });
}

async function pollUntil(check: () => boolean | Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// A slot refresh that is in flight when disconnect() clears the timer arms a new one when it
// finishes. Wait for it (refreshSlotsCache queues behind an in-flight refresh), then disconnect.
async function disconnectAfterRefresh(client: Cluster) {
  await new Promise<void>((resolve) => client.refreshSlotsCache(() => resolve()));
  client.disconnect();
}

describe("MemoryDB cluster clients after a failover", () => {
  // Catches: a store client that keeps sending to a failed primary that went silent (no closed
  // connection, no MOVED), so it never finds the promoted replica until the old node comes back.
  test.skipIf(!hasLocalRedisServer()).each([
    ["snapshot", snapshotClusterOptions],
    ["waitpoint", waitpointClusterOptions],
  ] as const)(
    "%s store client reaches the promoted replica while the old primary is frozen",
    async (_name, clusterOptions) => {
      const cluster = await startLocalRedisCluster({
        primaries: 3,
        replicas: 1,
        nodeTimeoutMs: 2000,
      });
      const seedPort = cluster.nodes[0]!.port;
      const key = "failover:probe";
      let frozenPid: number | undefined;
      const client = createRedisClusterClient(clusterOptions(`redis://127.0.0.1:${seedPort}`), {
        onError: () => {},
      });
      try {
        const nodes = parseClusterNodes(cluster.cli(seedPort, "cluster", "nodes"));
        const slot = Number(cluster.cli(seedPort, "cluster", "keyslot", key));
        const primary = nodes.find(
          (node) => node.flags.includes("master") && ownsSlot(node, slot)
        )!;
        const replica = nodes.find((node) => node.masterId === primary.id)!;

        // A replica that hasn't finished its first sync is never promoted.
        const synced = await pollUntil(
          () =>
            nodes
              .filter((node) => node.flags.includes("slave"))
              .every((node) =>
                cluster.cli(node.port, "info", "replication").includes("master_link_status:up")
              ),
          30_000
        );
        expect(synced).toBe(true);

        await client.connect();
        await client.set(key, "before");

        // SIGSTOP keeps the old primary's sockets open: nothing closes, nothing is reset.
        frozenPid = Number(
          /process_id:(\d+)/.exec(cluster.cli(primary.port, "info", "server"))![1]
        );
        process.kill(frozenPid, "SIGSTOP");

        const promoted = await pollUntil(
          () =>
            parseClusterNodes(cluster.cli(replica.port, "cluster", "nodes"))
              .find((node) => node.id === replica.id)!
              .flags.includes("master"),
          20_000
        );
        expect(promoted).toBe(true);

        // Without a periodic slot refresh this times out until the old primary is resumed.
        const reachedPromotedReplica = await pollUntil(async () => {
          await client.set(key, "after");
          return true;
        }, 10_000);
        expect(reachedPromotedReplica).toBe(true);
        expect(cluster.cli(replica.port, "get", key)).toBe("after");
      } finally {
        if (frozenPid !== undefined) process.kill(frozenPid, "SIGCONT");
        await disconnectAfterRefresh(client).catch(() => {});
        await cluster.stop();
      }
    },
    90_000
  );
});

function birthEntry(runId: string): SnapshotEntryInput {
  return {
    id: `${runId}_s0`,
    engine: "V2",
    executionStatus: "EXECUTING",
    description: "d",
    runId,
    runStatus: "EXECUTING",
    createdAt: "2026-08-21T00:00:00.000Z",
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    projectId: "proj_1",
    organizationId: "org_1",
  };
}

// No replicas and a long node timeout: the frozen primary is never failed over during the test, so
// only the store's own policy check decides whether writes to the other shards get through.
async function startClusterWithFreezablePrimary() {
  const cluster = await startLocalRedisCluster({ primaries: 3, nodeTimeoutMs: 60_000 });
  const ports = cluster.nodes.map((node) => node.port);
  const nodes = parseClusterNodes(cluster.cli(ports[0]!, "cluster", "nodes"));
  // Computed locally: a CLI call can't be sent to a frozen node without blocking the test.
  const ownerOf = (key: string) => {
    const slot = slotOf(key);
    return nodes.find((node) => node.flags.includes("master") && ownsSlot(node, slot))!.port;
  };
  const frozen: number[] = [];
  return {
    cluster,
    ownerOf,
    primaries: nodes.filter((node) => node.flags.includes("master")).map((node) => node.port),
    freeze(port: number) {
      const pid = Number(/process_id:(\d+)/.exec(cluster.cli(port, "info", "server"))![1]);
      process.kill(pid, "SIGSTOP");
      frozen.push(pid);
    },
    /** A run whose snapshot keys live on a shard other than `avoidPort`. */
    runIdAwayFrom(avoidPort: number, prefix: string) {
      for (let i = 0; ; i++) {
        const runId = `run_${prefix}_${i}`;
        if (ownerOf(snapshotKeys(runId).cur) !== avoidPort) return runId;
      }
    },
    /** Resume frozen primaries first, so closing a client doesn't wait on a node that never replies. */
    resume() {
      for (const pid of frozen.splice(0)) process.kill(pid, "SIGCONT");
    },
    async stop() {
      this.resume();
      await cluster.stop();
    },
  };
}

// Re-run the policy check on every command so a test needs no clock control.
const CHECK_EVERY_COMMAND = { policyCheckIntervalMs: 0 };

describe("MemoryDB store policy check with one primary down", () => {
  // Catches: the noeviction check needing every primary to answer, so one dead primary fails
  // writes to every shard instead of only its own.
  test.skipIf(!hasLocalRedisServer())(
    "snapshot writes to healthy shards succeed while another primary is frozen",
    async () => {
      const harness = await startClusterWithFreezablePrimary();
      const markerPort = harness.ownerOf(protocolMarkerKey());
      const frozenPort = harness.primaries.find((port) => port !== markerPort)!;
      const seedPort = harness.primaries.find((port) => port !== frozenPort)!;
      const connection = createSnapshotConnection(
        `redis://127.0.0.1:${seedPort}`,
        CHECK_EVERY_COMMAND
      );
      try {
        const store = connection.getStore();
        await store.append({
          entry: birthEntry(harness.runIdAwayFrom(frozenPort, "warm")),
          kind: "birth",
          isTerminal: false,
        });

        harness.freeze(frozenPort);
        await expect(
          store.append({
            entry: birthEntry(harness.runIdAwayFrom(frozenPort, "healthy")),
            kind: "birth",
            isTerminal: false,
          })
        ).resolves.toBeDefined();
      } finally {
        harness.resume();
        await connection.close().catch(() => {});
        await harness.stop();
      }
    },
    60_000
  );

  // Catches: losing the protocol marker's shard failing every snapshot write, and the opposite
  // regression of a process that never confirmed the marker writing anyway.
  test.skipIf(!hasLocalRedisServer())(
    "snapshot writes keep a confirmed protocol when the marker's primary is frozen",
    async () => {
      const harness = await startClusterWithFreezablePrimary();
      const frozenPort = harness.ownerOf(protocolMarkerKey());
      const seedPort = harness.primaries.find((port) => port !== frozenPort)!;
      const endpoint = `redis://127.0.0.1:${seedPort}`;
      const confirmed = createSnapshotConnection(endpoint, CHECK_EVERY_COMMAND);
      const unconfirmed = createSnapshotConnection(endpoint, CHECK_EVERY_COMMAND);
      try {
        await confirmed.getStore().append({
          entry: birthEntry(harness.runIdAwayFrom(frozenPort, "warm")),
          kind: "birth",
          isTerminal: false,
        });

        harness.freeze(frozenPort);
        await expect(
          confirmed.getStore().append({
            entry: birthEntry(harness.runIdAwayFrom(frozenPort, "confirmed")),
            kind: "birth",
            isTerminal: false,
          })
        ).resolves.toBeDefined();
        await expect(
          unconfirmed.getStore().append({
            entry: birthEntry(harness.runIdAwayFrom(frozenPort, "unconfirmed")),
            kind: "birth",
            isTerminal: false,
          })
        ).rejects.toThrow();
      } finally {
        harness.resume();
        await confirmed.close().catch(() => {});
        await unconfirmed.close().catch(() => {});
        await harness.stop();
      }
    },
    60_000
  );

  // Catches: the waitpoint store's noeviction check failing every command when one primary is down.
  test.skipIf(!hasLocalRedisServer())(
    "waitpoint store commands pass the policy check while one primary is frozen",
    async () => {
      const harness = await startClusterWithFreezablePrimary();
      const frozenPort = harness.primaries[0]!;
      const seedPort = harness.primaries[1]!;
      const connection = createWaitpointStoreConnection(
        `redis://127.0.0.1:${seedPort}`,
        CHECK_EVERY_COMMAND
      );
      try {
        await connection.store.prepareForKeyedCreation();

        harness.freeze(frozenPort);
        await expect(connection.store.prepareForKeyedCreation()).resolves.toBeUndefined();
      } finally {
        harness.resume();
        await connection.close().catch(() => {});
        await harness.stop();
      }
    },
    60_000
  );
});

describe("MemoryDB store policy check when a primary refuses it", () => {
  // Catches: treating a live primary's explicit refusal (NOPERM) like an unreachable node, which
  // would let writes reach a shard whose eviction policy was never checked.
  test.skipIf(!hasLocalRedisServer())(
    "snapshot writes fail when a live primary refuses INFO",
    async () => {
      const harness = await startClusterWithFreezablePrimary();
      const refusingPort = harness.primaries.find(
        (port) => port !== harness.ownerOf(protocolMarkerKey())
      )!;
      const seedPort = harness.primaries.find((port) => port !== refusingPort)!;
      const connection = createSnapshotConnection(
        `redis://127.0.0.1:${seedPort}`,
        CHECK_EVERY_COMMAND
      );
      try {
        harness.cluster.cli(refusingPort, "acl", "setuser", "default", "-info");
        await expect(
          connection.getStore().append({
            entry: birthEntry(harness.runIdAwayFrom(refusingPort, "refused")),
            kind: "birth",
            isTerminal: false,
          })
        ).rejects.toThrow(/NOPERM/);
      } finally {
        await connection.close().catch(() => {});
        await harness.stop();
      }
    },
    60_000
  );

  // Catches: the same explicit refusal being skipped by the waitpoint store's check.
  test.skipIf(!hasLocalRedisServer())(
    "waitpoint commands fail when a live primary refuses INFO",
    async () => {
      const harness = await startClusterWithFreezablePrimary();
      const refusingPort = harness.primaries[0]!;
      const connection = createWaitpointStoreConnection(
        `redis://127.0.0.1:${harness.primaries[1]!}`,
        CHECK_EVERY_COMMAND
      );
      try {
        harness.cluster.cli(refusingPort, "acl", "setuser", "default", "-info");
        await expect(connection.store.prepareForKeyedCreation()).rejects.toThrow(/NOPERM/);
      } finally {
        await connection.close().catch(() => {});
        await harness.stop();
      }
    },
    60_000
  );
});
