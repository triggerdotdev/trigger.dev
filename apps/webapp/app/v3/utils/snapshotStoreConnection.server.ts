import { createRedisClusterClient, type Cluster } from "@internal/redis";
import {
  isTransientRedisClientError,
  RedisSnapshotStore,
  type SnapshotStoreMetrics,
} from "@internal/run-store";

const DEFAULT_COMPLETED_TTL_MS = 4 * 24 * 60 * 60 * 1_000;
const COMMAND_TIMEOUT_MS = 1_000;
const CONNECT_TIMEOUT_MS = 500;
const SLOTS_REFRESH_INTERVAL_MS = 2_000;
const SLOT_REFRESH_SETTLE_MS = 2_000;
const POLICY_CHECK_INTERVAL_MS = 30_000;

/**
 * ioredis arms the next periodic slot refresh from the callback of the current one, so a refresh in
 * flight when the client closes leaves a timer running afterwards. refreshSlotsCache queues a
 * callback behind an in-flight refresh: wait for it, bounded in case no node answers, and if it only
 * finishes after the client closed, disconnect again to clear the timer that refresh armed.
 */
async function quitAfterSlotRefresh(connection: Cluster) {
  let disconnected = false;
  let settleTimer: NodeJS.Timeout | undefined;
  try {
    if (connection.status === "ready") {
      await Promise.race([
        new Promise<void>((resolve) =>
          connection.refreshSlotsCache(() => {
            if (disconnected) connection.disconnect();
            resolve();
          })
        ),
        new Promise<void>((resolve) => {
          settleTimer = setTimeout(resolve, SLOT_REFRESH_SETTLE_MS);
        }),
      ]);
    }
    await connection.quit();
  } finally {
    clearTimeout(settleTimer);
    connection.disconnect();
    disconnected = true;
  }
}

/** Infrastructure only. Rollout modes belong to the existing polled flags, not this URL. */
export function snapshotClusterOptions(endpoint: string) {
  const url = new URL(endpoint);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("Snapshot endpoint must use redis:// or rediss://");
  }
  if ((url.pathname && url.pathname !== "/" && url.pathname !== "/0") || url.search || url.hash) {
    throw new Error("Snapshot cluster endpoint cannot select a database or operational options");
  }
  return {
    nodes: [{ host: url.hostname, port: Number(url.port || 6379) }],
    failFast: true,
    clusterOptions: {
      lazyConnect: true,
      scaleReads: "master" as const,
      // ioredis only re-reads the slot map on MOVED or a closed connection. A failed primary that
      // goes silent sends neither, so without a periodic refresh the client never finds the
      // promoted replica.
      slotsRefreshInterval: SLOTS_REFRESH_INTERVAL_MS,
      ...(url.protocol === "rediss:" && {
        // Preserve the seed hostname; AWS TLS certificates do not identify private IPs.
        dnsLookup: (address: string, callback: (err: Error | null, address: string) => void) =>
          callback(null, address),
      }),
    },
    redisOptions: {
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      // Discovered nodes can be IPs too; verify them against the configured cluster hostname.
      tls: url.protocol === "rediss:" ? { servername: url.hostname } : undefined,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
    },
  };
}

/**
 * No client, socket, timer or probe until getStore() is used by an actual Redis-resident operation.
 * The app keeps its client for the process lifetime. This factory installs no signal handlers and
 * must not be closed underneath the app's independent HTTP and background consumers.
 */
export function createSnapshotConnection(
  endpoint: string,
  options: {
    metrics?: SnapshotStoreMetrics;
    onError?: (error: Error) => void;
    /** How long a finished run's snapshot state stays in the store. */
    completedTtlMs?: number;
    /** How long a passed memory-policy check is trusted. Defaults to 30s. */
    policyCheckIntervalMs?: number;
  } = {}
) {
  const clientOptions = snapshotClusterOptions(endpoint);
  let client: Cluster | undefined;
  let store: RedisSnapshotStore | undefined;
  let connecting: Promise<void> | undefined;
  let policyCheck: Promise<void> | undefined;
  const policyCheckIntervalMs = options.policyCheckIntervalMs ?? POLICY_CHECK_INTERVAL_MS;
  let policyCheckedAt = 0;
  let protocolCompatible = false;
  let closed = false;

  function getClient() {
    if (closed) throw new Error("Snapshot connection is closed");
    return (client ??= createRedisClusterClient(clientOptions, { onError: options.onError }));
  }

  async function ready() {
    const connection = getClient();
    if (connection.status === "ready") return;
    if (!connecting) {
      connecting = new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          connection.off("ready", onReady);
          connection.off("end", onEnd);
          error ? reject(error) : resolve();
        };
        const onReady = () => finish();
        const onEnd = () => finish(new Error("Snapshot cluster connection ended"));
        const timeout = setTimeout(
          () => finish(new Error("Snapshot cluster connection timed out")),
          CONNECT_TIMEOUT_MS
        );
        connection.once("ready", onReady);
        connection.once("end", onEnd);
        if (connection.status === "wait" || connection.status === "end") {
          connection.connect().catch(finish);
        }
      }).finally(() => {
        connecting = undefined;
      });
    }
    await connecting;
  }

  async function beforeCommand(operation: string) {
    await ready();
    if (operation !== "prepare" && operation !== "append") return;
    if (Date.now() - policyCheckedAt < policyCheckIntervalMs) return;
    policyCheck ??= (async () => {
      // INFO is supported by MemoryDB, whereas CONFIG is restricted. Check every primary that
      // answers: a primary that is down must not block writes to the shards that are still up.
      const nodes = getClient().nodes("master");
      if (nodes.length === 0) throw new Error("Snapshot cluster has no primary nodes");
      const results = await Promise.allSettled(nodes.map((node) => node.info("memory")));
      const memory: string[] = [];
      let unreachable: unknown;
      for (const result of results) {
        if (result.status === "fulfilled") memory.push(result.value);
        // Only a node that didn't answer is skipped. A reply error such as NOPERM fails the check.
        else if (isTransientRedisClientError(result.reason)) unreachable ??= result.reason;
        else throw result.reason;
      }
      if (memory.length === 0) throw unreachable;
      if (memory.some((info) => !/^maxmemory_policy:noeviction\r?$/m.test(info))) {
        throw new Error("Snapshot writes require noeviction on every primary");
      }
      try {
        const protocol = await store!.readOrBootstrapProtocolMarker("1");
        protocolCompatible = protocol.compatible;
        if (!protocol.compatible) throw new Error("Snapshot cluster protocol is incompatible");
      } catch (error) {
        // The marker is one key on one shard. Once this process has seen it compatible, failing to
        // reach that shard keeps the earlier result instead of failing writes to every shard.
        if (!(protocolCompatible && isTransientRedisClientError(error))) throw error;
      }
      policyCheckedAt = Date.now();
    })().finally(() => {
      policyCheck = undefined;
    });
    await policyCheck;
  }

  return {
    getStore: () =>
      (store ??= new RedisSnapshotStore({
        client: getClient(),
        completedTtlMs: options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS,
        beforeCommand,
        metrics: options.metrics,
      })),
    getClient,
    ready,
    /** Caller must first drain all users. No app signal path invokes this. */
    close: async () => {
      if (closed) return;
      closed = true;
      if (client) {
        if (client.status === "wait" || client.status === "end") {
          client.disconnect();
          return;
        }
        await quitAfterSlotRefresh(client);
      }
    },
  };
}
