import { createRedisClusterClient, type Cluster } from "@internal/redis";
import type { Meter } from "@internal/tracing";
import { WaitpointStoreCoordinator } from "@internal/run-engine";
import { isTransientRedisClientError } from "@internal/run-store";

const CONNECT_TIMEOUT_MS = 1_000;
const COMMAND_TIMEOUT_MS = 2_000;
const SLOTS_REFRESH_INTERVAL_MS = 5_000;
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

/** Infrastructure configuration alone never enables waitpoint routing. */
export function waitpointClusterOptions(endpoint: string) {
  const url = new URL(endpoint);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("Waitpoint endpoint must use redis:// or rediss://");
  }
  if ((url.pathname && url.pathname !== "/" && url.pathname !== "/0") || url.search || url.hash) {
    throw new Error("Waitpoint cluster endpoint cannot select a database or operational options");
  }
  return {
    nodes: [{ host: url.hostname, port: Number(url.port || 6379) }],
    failFast: true,
    // Spread connect attempts across the endpoint's nodes; see snapshotStoreConnection.server.ts.
    spreadStartupNodes: true,
    clusterOptions: {
      lazyConnect: true,
      scaleReads: "master" as const,
      // Find a promoted replica after a failover; see snapshotStoreConnection.server.ts.
      slotsRefreshInterval: SLOTS_REFRESH_INTERVAL_MS,
    },
    redisOptions: {
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      // Slot discovery can replace the connection hostname with an IP. Keep the original name
      // for TLS verification and SNI, just as the snapshot MemoryDB connection does.
      tls: url.protocol === "rediss:" ? { servername: url.hostname } : undefined,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
    },
  };
}

/** No client, socket, timer or probe until an enabled store operation uses the facade. */
export function createWaitpointStoreConnection(
  endpoint: string,
  options: {
    meter?: Meter;
    onError?: (error: Error) => void;
    onActivate?: () => void;
    /** How long a passed memory-policy check is trusted. Defaults to 30s. */
    policyCheckIntervalMs?: number;
    /** How long completed waitpoint records are kept. Defaults to the coordinator's 14 days. */
    completedTtlMs?: number;
  } = {}
) {
  let client: Cluster | undefined;
  let store: WaitpointStoreCoordinator | undefined;
  let connecting: Promise<void> | undefined;
  let policyCheck: Promise<void> | undefined;
  const policyCheckIntervalMs = options.policyCheckIntervalMs ?? POLICY_CHECK_INTERVAL_MS;
  let policyCheckedAt = 0;
  let closed = false;
  const activationListeners = new Set<() => void>();
  if (options.onActivate) activationListeners.add(options.onActivate);

  function getClient() {
    if (closed) throw new Error("Waitpoint connection is closed");
    return (client ??= createRedisClusterClient(waitpointClusterOptions(endpoint), {
      onError: options.onError,
    }));
  }

  async function ready() {
    const connection = getClient();
    if (connection.status === "ready") return;
    connecting ??= new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        connection.off("ready", onReady);
        connection.off("end", onEnd);
        error ? reject(error) : resolve();
      };
      const onReady = () => finish();
      const onEnd = () => finish(new Error("Waitpoint cluster connection ended"));
      const timeout = setTimeout(
        () => finish(new Error("Waitpoint cluster connection timed out")),
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
    await connecting;
  }

  async function beforeCommand() {
    await ready();
    if (Date.now() - policyCheckedAt < policyCheckIntervalMs) return;
    policyCheck ??= (async () => {
      const nodes = getClient().nodes("master");
      if (nodes.length === 0) throw new Error("Waitpoint cluster has no primary nodes");
      // A primary that is down must not block commands to the shards that are still up.
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
        throw new Error("Waitpoint coordination requires noeviction on every primary");
      }
      policyCheckedAt = Date.now();
    })().finally(() => {
      policyCheck = undefined;
    });
    await policyCheck;
  }

  function getStore() {
    if (!store) {
      store = new WaitpointStoreCoordinator({
        client: getClient(),
        beforeCommand,
        meter: options.meter,
        terminalRetentionMs: options.completedTtlMs,
      });
      for (const listener of activationListeners) listener();
      activationListeners.clear();
    }
    return store;
  }

  const methods = new Set(
    Object.getOwnPropertyNames(WaitpointStoreCoordinator.prototype).filter(
      (name) =>
        name !== "constructor" &&
        typeof Object.getOwnPropertyDescriptor(WaitpointStoreCoordinator.prototype, name)?.value ===
          "function"
    )
  );

  // Catalog access must stay as lazy as coordinator method access. Only invocation resolves
  // the shared store, and private catalog fields require binding to its actual instance.
  type Catalog = WaitpointStoreCoordinator["manualCatalog"];
  const catalogMethods = new Set<keyof Catalog>([
    "getManifest",
    "publish",
    "publishCompletedCandidate",
    "reconcileStatus",
    "retire",
    "list",
  ]);
  const manualCatalog = new Proxy({} as Catalog, {
    get(_target, property) {
      if (property === "toString") return () => "[object ManualWaitpointCatalog]";
      if (typeof property !== "string" || !catalogMethods.has(property as keyof Catalog))
        return undefined;
      return (...args: unknown[]) => {
        const catalog = getStore().manualCatalog;
        return Reflect.apply(Reflect.get(catalog, property), catalog, args);
      };
    },
  });

  // The engine/router accept a coordinator synchronously. Resolve and bind only the method an
  // enabled path invokes; construction of the engine cannot instantiate a Redis client.
  const facade = new Proxy({} as WaitpointStoreCoordinator, {
    get(_target, property) {
      if (property === "manualCatalog") return manualCatalog;
      if (property === "quit") return async () => {};
      if (property === "toString") return () => "[object WaitpointStoreCoordinator]";
      if (typeof property !== "string" || !methods.has(property)) return undefined;
      return (...args: unknown[]) => {
        const coordinator = getStore();
        return Reflect.apply(Reflect.get(coordinator, property), coordinator, args);
      };
    },
  });

  return {
    store: facade,
    /** Consumers may register after another consumer has already activated the shared client. */
    onActivate(listener: () => void) {
      if (store) listener();
      else activationListeners.add(listener);
    },
    /** Call only after every HTTP and background consumer has drained. */
    close: async () => {
      if (closed) return;
      closed = true;
      if (!client) return;
      if (client.status === "wait" || client.status === "end") {
        client.disconnect();
        return;
      }
      await quitAfterSlotRefresh(client);
    },
  };
}
