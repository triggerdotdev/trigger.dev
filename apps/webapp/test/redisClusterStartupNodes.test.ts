import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createRedisClusterClient,
  type Cluster,
  type StartupNodeLookupOptions,
  type StartupNodeSkipSummary,
} from "@internal/redis";
import {
  hasLocalRedisServer,
  startLocalRedisCluster,
  type LocalRedisCluster,
} from "@internal/testcontainers";

// The store clients connect for real here, not through the webapp's ioredis stub.
vi.unmock("ioredis");

type ResolveAll = NonNullable<StartupNodeLookupOptions["resolve"]>;

const DEAD_ADDRESS = "192.0.2.1";
// The startup hostname is never resolved by the OS: every lookup goes through a fixed `resolve`.
const STARTUP_HOST = "cluster.store.test";

const fixedAddresses =
  (...addresses: string[]): ResolveAll =>
  (_hostname, _options, callback) =>
    callback(
      null,
      addresses.map((address) => ({ address, family: 4 }))
    );

/** Answers the first lookup with only the first address, and later lookups with all of them. */
function firstLookupGetsOnly(...addresses: string[]): ResolveAll {
  let lookups = 0;
  return (hostname, options, callback) =>
    fixedAddresses(...(lookups++ === 0 ? addresses.slice(0, 1) : addresses))(
      hostname,
      options,
      callback
    );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForStatus(cluster: Cluster, status: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cluster.status === status) return true;
    await sleep(50);
  }
  return cluster.status === status;
}

describe.skipIf(!hasLocalRedisServer())("cluster clients with spreadStartupNodes", () => {
  let cluster: LocalRedisCluster;
  // Accepts a TCP connection and never answers or closes it, so a client socket to it can only
  // end when ioredis destroys it after disconnectTimeout.
  let hangServer: Server;
  let hangPort: number;
  const heldSockets = new Set<Socket>();

  beforeAll(async () => {
    cluster = await startLocalRedisCluster({ primaries: 3, replicas: 1 });
    // The stuck-in-close tests remap a replica, so every replica must be in the slot map.
    const seedPort = cluster.nodes[0]!.port;
    const replicasUp = () => {
      const replicaPorts = cluster
        .cli(seedPort, "cluster", "nodes")
        .split("\n")
        .filter((line) => line.includes("slave"))
        .map((line) => Number(line.split(" ")[1]!.split("@")[0]!.split(":")[1]));
      return (
        replicaPorts.length === 3 &&
        replicaPorts.every((port) =>
          cluster.cli(port, "info", "replication").includes("master_link_status:up")
        )
      );
    };
    const deadline = Date.now() + 30_000;
    while (!replicasUp()) {
      if (Date.now() > deadline) throw new Error("replicas did not sync");
      await sleep(200);
    }
    hangServer = createServer({ allowHalfOpen: true }, (socket) => {
      heldSockets.add(socket);
      socket.on("close", () => heldSockets.delete(socket));
    });
    await new Promise<void>((resolve) => hangServer.listen(0, "127.0.0.1", resolve));
    hangPort = (hangServer.address() as { port: number }).port;
  }, 60_000);

  /**
   * Remaps one replica to the hang server and starts a command on it, so that node's socket can
   * only end after disconnectTimeout. Retries the slot refresh because a refresh already in flight
   * may have read the slot map before the remap.
   */
  async function hangOneReplica(client: Cluster, remap: (nodeKey: string) => void) {
    const deadline = Date.now() + 5_000;
    const refresh = () => new Promise<void>((done) => client.refreshSlotsCache(() => done()));
    while (client.nodes("slave").length === 0) {
      if (Date.now() > deadline) throw new Error("client never saw a replica");
      await refresh();
      await sleep(100);
    }
    const replica = client.nodes("slave")[0]!;
    remap(`${replica.options.host}:${replica.options.port}`);
    let hungNode = client.nodes("slave").find((node) => node.options.port === hangPort);
    while (!hungNode) {
      if (Date.now() > deadline) throw new Error("hang server never joined the pool");
      await refresh();
      hungNode = client.nodes("slave").find((node) => node.options.port === hangPort);
    }
    hungNode.ping().catch(() => {});
    await sleep(100);
  }

  afterAll(async () => {
    // beforeAll can fail before the hang server exists; the cluster must be stopped either way.
    try {
      for (const socket of heldSockets) socket.destroy();
      if (hangServer) await new Promise((resolve) => hangServer.close(resolve));
    } finally {
      await cluster?.stop();
    }
  }, 30_000);

  // Catches: a client whose startup lookup keeps returning a dead node never reads the slot map.
  it("brings every new client up when the endpoint resolves to a dead node first", async () => {
    const seedPort = cluster.nodes[0]!.port;
    const clients = Array.from({ length: 12 }, (_, index) =>
      createRedisClusterClient({
        nodes: [{ host: STARTUP_HOST, port: seedPort }],
        failFast: true,
        // The dead address comes first, as the first DNS record would. The first client's first
        // lookup returns only the dead address, so at least one client always starts on it.
        spreadStartupNodes: {
          resolve:
            index === 0
              ? firstLookupGetsOnly(DEAD_ADDRESS, "127.0.0.1")
              : fixedAddresses(DEAD_ADDRESS, "127.0.0.1"),
        },
        clusterOptions: { lazyConnect: true, slotsRefreshTimeout: 300 },
        redisOptions: { connectTimeout: 300, commandTimeout: 500 },
      })
    );
    const deadNodeErrors = clients.map(() => 0);
    clients.forEach((client, index) =>
      client.on("node error", (_error: Error, node: string) => {
        if (node.startsWith(`${DEAD_ADDRESS}:`)) deadNodeErrors[index]!++;
      })
    );

    try {
      const started = Date.now();
      await Promise.all(
        clients.map(async (client, index) => {
          // connect() rejects when its first attempt fails even though the client keeps retrying,
          // so wait for "ready" as the stores do.
          client.connect().catch(() => {});
          expect(await waitForStatus(client, "ready", 5_000)).toBe(true);
          await client.set(`spread:${index}`, "ok");
          expect(await client.get(`spread:${index}`)).toBe("ok");
        })
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      // The scenario ran: the first client started on the dead node and still came up.
      expect(deadNodeErrors[0]).toBe(1);
      // Once a client fails on the dead node, its next lookup avoids it.
      for (const errors of deadNodeErrors) expect(errors).toBeLessThanOrEqual(1);
    } finally {
      for (const client of clients) client.disconnect();
    }
  }, 15_000);

  // Catches: logging the skipped addresses on every lookup during an outage, or not at all.
  it("reports skipped addresses once, when the client becomes ready", async () => {
    const seedPort = cluster.nodes[0]!.port;
    const SECOND_DEAD_ADDRESS = "192.0.2.2";
    // Each answer adds one address, so the first two attempts fail on dead nodes and the second
    // and third lookups both skip an address.
    const answers = [
      [DEAD_ADDRESS],
      [DEAD_ADDRESS, SECOND_DEAD_ADDRESS],
      [DEAD_ADDRESS, SECOND_DEAD_ADDRESS, "127.0.0.1"],
    ];
    let lookups = 0;
    const resolve: ResolveAll = (hostname, options, callback) =>
      fixedAddresses(...answers[Math.min(lookups++, answers.length - 1)]!)(
        hostname,
        options,
        callback
      );
    const summaries: StartupNodeSkipSummary[] = [];
    const client = createRedisClusterClient({
      nodes: [{ host: STARTUP_HOST, port: seedPort }],
      failFast: true,
      spreadStartupNodes: { resolve, onSkipSummary: (summary) => summaries.push(summary) },
      clusterOptions: { lazyConnect: true, slotsRefreshTimeout: 300 },
      redisOptions: { connectTimeout: 300, commandTimeout: 500 },
    });
    try {
      client.connect().catch(() => {});
      expect(await waitForStatus(client, "ready", 5_000)).toBe(true);
      expect(lookups).toBe(3);
      expect(summaries).toEqual([
        {
          hostname: STARTUP_HOST,
          chosen: "127.0.0.1",
          skipped: [DEAD_ADDRESS, SECOND_DEAD_ADDRESS],
          lookups: 3,
        },
      ]);
    } finally {
      client.disconnect();
    }
  }, 15_000);

  /**
   * Reproduces the ioredis < 6.1.0 stuck-in-close state: a replica is remapped to the hang server
   * so its socket only ends after disconnectTimeout. disconnect(true) starts a reconnect that waits
   * in a slow startup lookup; meanwhile the hung socket ends, the pool drains and the cluster goes
   * to "close". connect() then rejects "Connection is aborted" and no retry is scheduled.
   */
  async function driveIntoClose(withGuard: boolean) {
    const seedPort = cluster.nodes[0]!.port;
    let slowLookup = false;
    const lookupDelayMs = 500;
    const resolve: ResolveAll = (hostname, options, callback) => {
      const answer = () => fixedAddresses("127.0.0.1")(hostname, options, callback);
      if (slowLookup) setTimeout(answer, lookupDelayMs);
      else answer();
    };
    let hungNodeKey: string | undefined;

    const client = createRedisClusterClient({
      nodes: [{ host: STARTUP_HOST, port: seedPort }],
      failFast: true,
      spreadStartupNodes: withGuard && { resolve },
      clusterOptions: {
        lazyConnect: true,
        // Same lookup without the guard, so the two runs differ only in the guard.
        ...(!withGuard && {
          dnsLookup: (hostname: string, callback: (error: Error | null, address: string) => void) =>
            resolve(hostname, { all: true }, (error, records) =>
              callback(error, records[0]!.address)
            ),
        }),
        natMap: (key: string) =>
          key === hungNodeKey ? { host: "127.0.0.1", port: hangPort } : (null as never),
      },
      redisOptions: { connectTimeout: 5_000, commandTimeout: 1_000, disconnectTimeout: 300 },
    });

    await client.connect();
    await hangOneReplica(client, (nodeKey) => (hungNodeKey = nodeKey));

    slowLookup = true;
    client.disconnect(true);
    return client;
  }

  it("stays closed without the guard (ioredis < 6.1.0)", async () => {
    // The control for the guard tests. If ioredis stops getting stuck, the guard is dead code.
    const fixedUpstream =
      "ioredis now recovers from an aborted connect on its own (fixed in 6.1.0): delete " +
      "keepClusterConnecting, its wiring in createRedisClusterClient, and this test";
    const client = await driveIntoClose(false);
    try {
      expect(await waitForStatus(client, "close", 2_000), fixedUpstream).toBe(true);
      // Longer than the default cluster retry strategy's largest delay (2s).
      await sleep(4_000);
      expect(client.status, fixedUpstream).toBe("close");
    } finally {
      client.disconnect();
    }
  }, 15_000);

  // Catches: a client left in "close" by ioredis is never reconnected.
  it("reconnects with the guard", async () => {
    const client = await driveIntoClose(true);
    try {
      expect(await waitForStatus(client, "close", 2_000)).toBe(true);
      expect(await waitForStatus(client, "ready", 6_000)).toBe(true);
      await client.set("guard:recovered", "ok");
    } finally {
      client.disconnect();
    }
  }, 15_000);

  // Catches: the guard reviving a client its owner closed. A pooled socket that ends after the
  // disconnect drains the pool and sets status back to "close".
  it("does not reconnect a client after disconnect()", async () => {
    const seedPort = cluster.nodes[0]!.port;
    let hungNodeKey: string | undefined;
    const client = createRedisClusterClient({
      nodes: [{ host: STARTUP_HOST, port: seedPort }],
      failFast: true,
      spreadStartupNodes: { resolve: fixedAddresses("127.0.0.1") },
      clusterOptions: {
        lazyConnect: true,
        natMap: (key: string) =>
          key === hungNodeKey ? { host: "127.0.0.1", port: hangPort } : (null as never),
      },
      redisOptions: { connectTimeout: 5_000, commandTimeout: 1_000, disconnectTimeout: 300 },
    });
    const statuses: string[] = [];
    try {
      await client.connect();
      await hangOneReplica(client, (nodeKey) => (hungNodeKey = nodeKey));

      client.disconnect();
      for (const status of ["connecting", "connect", "ready"]) {
        client.on(status, () => statuses.push(status));
      }
      expect(await waitForStatus(client, "close", 2_000)).toBe(true);
      await sleep(4_000);
      expect(statuses).toEqual([]);
      expect(client.status).toBe("close");
    } finally {
      client.disconnect();
    }
  }, 15_000);

  // Catches: the guard reviving a client its owner closed while an ioredis reconnect was pending.
  // ioredis has already handled that close, so the late drain sets "close" without emitting "end".
  it("does not reconnect a client closed while a reconnect is pending", async () => {
    const seedPort = cluster.nodes[0]!.port;
    let hungNodeKey: string | undefined;
    const client = createRedisClusterClient({
      nodes: [{ host: STARTUP_HOST, port: seedPort }],
      failFast: true,
      spreadStartupNodes: { resolve: fixedAddresses("127.0.0.1") },
      clusterOptions: {
        lazyConnect: true,
        natMap: (key: string) =>
          key === hungNodeKey ? { host: "127.0.0.1", port: hangPort } : (null as never),
      },
      redisOptions: { connectTimeout: 5_000, commandTimeout: 1_000, disconnectTimeout: 300 },
    });
    const statuses: string[] = [];
    try {
      await client.connect();
      await hangOneReplica(client, (nodeKey) => (hungNodeKey = nodeKey));

      // As a failed ready check does: the healthy nodes end, ioredis schedules a reconnect, and
      // the hung socket keeps the pool's last drain pending.
      client.disconnect(true);
      await sleep(30);
      // The owner closes it the way the stores' close() does when the client is not ready.
      await client.quit().catch(() => {});
      client.disconnect();
      for (const status of ["connecting", "connect", "ready"]) {
        client.on(status, () => statuses.push(status));
      }
      expect(await waitForStatus(client, "close", 2_000)).toBe(true);
      await sleep(4_000);
      expect(statuses).toEqual([]);
      expect(client.status).toBe("close");
    } finally {
      client.disconnect();
    }
  }, 15_000);
});
