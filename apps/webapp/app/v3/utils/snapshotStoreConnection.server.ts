import { createRedisClusterClient, type Cluster } from "@internal/redis";
import { RedisSnapshotStore, type SnapshotStoreMetrics } from "@internal/run-store";

const COMMAND_TIMEOUT_MS = 500;
const CONNECT_TIMEOUT_MS = 500;
const POLICY_CHECK_INTERVAL_MS = 30_000;
const COMPLETED_TTL_MS = 14 * 24 * 60 * 60 * 1_000;

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
    clusterOptions: { lazyConnect: true, scaleReads: "master" as const },
    redisOptions: {
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      tls: url.protocol === "rediss:" ? {} : undefined,
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
  options: { metrics?: SnapshotStoreMetrics; onError?: (error: Error) => void } = {}
) {
  const clientOptions = snapshotClusterOptions(endpoint);
  let client: Cluster | undefined;
  let store: RedisSnapshotStore | undefined;
  let connecting: Promise<void> | undefined;
  let policyCheck: Promise<void> | undefined;
  let policyCheckedAt = 0;
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
    if (Date.now() - policyCheckedAt < POLICY_CHECK_INTERVAL_MS) return;
    policyCheck ??= (async () => {
      // INFO is supported by MemoryDB, whereas CONFIG is restricted. Check every current primary.
      const nodes = getClient().nodes("master");
      if (nodes.length === 0) throw new Error("Snapshot cluster has no primary nodes");
      const memory = await Promise.all(nodes.map((node) => node.info("memory")));
      if (memory.some((info) => !/^maxmemory_policy:noeviction\r?$/m.test(info))) {
        throw new Error("Snapshot writes require noeviction on every primary");
      }
      const protocol = await store!.readOrBootstrapProtocolMarker("1");
      if (!protocol.compatible) throw new Error("Snapshot cluster protocol is incompatible");
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
        completedTtlMs: COMPLETED_TTL_MS,
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
        try {
          await client.quit();
        } finally {
          client.disconnect();
        }
      }
    },
  };
}
