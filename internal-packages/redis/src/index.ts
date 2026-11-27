import {
  Redis,
  type Cluster,
  type ClusterNode,
  type ClusterOptions,
  type RedisOptions,
} from "ioredis";
import { Logger } from "@trigger.dev/core/logger";
import {
  createStartupNodeLookup,
  keepClusterConnecting,
  type StartupNodeLookupOptions,
} from "./startupNodeLookup.js";

export { type StartupNodeLookupOptions, type StartupNodeSkipSummary } from "./startupNodeLookup.js";

export {
  Redis,
  Cluster,
  type Callback,
  type RedisOptions,
  type ClusterNode,
  type ClusterOptions,
  type Result,
  type RedisCommander,
} from "ioredis";

/**
 * Either endpoint shape. A component that only issues key-addressed commands works against both, so
 * it should accept this rather than pin itself to a standalone connection. Commands with no key —
 * SCAN above all — do NOT fan out across a cluster, so anything that issues one must iterate
 * `cluster.nodes("master")` itself.
 */
export type RedisClient = Redis | Cluster;

/**
 * Reply-error -> reconnect mapping. Without this hook, an ElastiCache
 * vertical scale-up surfaces tens of thousands of READONLY / LOADING
 * reply errors to caller code over a healthy TCP/TLS connection (the
 * client keeps talking to a node whose role swapped underneath it).
 *
 * UNBLOCKED is the BLPOP-shaped case: the Redis primary forcibly
 * unblocks any blocking command on a connection whose node is about
 * to be demoted, returning an UNBLOCKED reply. Surfaced 65 times on
 * engine/v1/worker-actions/dequeue at the cutover instant during the
 * TRI-8873 test-cloud scale-up dry-run.
 *
 * Returning 2 tells ioredis to disconnect, reconnect, and retry the
 * command that triggered the error. After reconnect, DNS / SG routing
 * should land on a writable primary.
 *
 * Empirical confirmation on the harness in TRI-8878: this option
 * reduced a scale-up event from ~437,000 caller-surfaced errors to 2.
 */
export function defaultReconnectOnError(err: Error): boolean | 1 | 2 {
  const msg = err.message ?? "";
  if (msg.startsWith("READONLY") || msg.startsWith("LOADING") || msg.startsWith("UNBLOCKED")) {
    return 2;
  }
  return false;
}

const defaultOptions: Partial<RedisOptions> = {
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 1000);
    return delay;
  },
  maxRetriesPerRequest: process.env.GITHUB_ACTIONS ? 50 : process.env.VITEST ? 5 : 20,
  reconnectOnError: defaultReconnectOnError,
};

const logger = new Logger("Redis", "debug");

export function createRedisClient(
  options: RedisOptions,
  handlers?: { onError?: (err: Error) => void }
): Redis {
  const client = new Redis({
    ...defaultOptions,
    ...options,
  });

  // Skip error handling setup if running in Vitest
  if (process.env.VITEST) {
    client.on("error", (error) => {
      // swallow errors
    });
    return client;
  }

  client.on("error", (error) => {
    if (handlers?.onError) {
      handlers.onError(error);
    } else {
      logger.error(`Redis client error:`, { error, keyPrefix: options.keyPrefix });
    }
  });

  return client;
}

export type RedisClusterClientOptions = {
  nodes: ClusterNode[];
  clusterOptions?: Omit<ClusterOptions, "redisOptions">;
  redisOptions?: RedisOptions;
  /**
   * Fail a command while the cluster is unreachable instead of queueing it. For a caller on a
   * request path, where a queued command means a hung request rather than a slow one.
   */
  failFast?: boolean;
  /**
   * For a startup hostname that resolves to every node in the cluster: connect to a random node
   * each attempt, skipping nodes that recently failed, instead of always the first DNS record. Also
   * reconnects a client that ioredis left closed with no retry scheduled. `true` uses the defaults.
   */
  spreadStartupNodes?: boolean | StartupNodeLookupOptions;
};

/**
 * Cluster-mode client. `defaultOptions` go on the INNER per-node options, so a role swap gets the
 * same reconnect-and-retry treatment a single-node client already gets.
 */
export function createRedisClusterClient(
  options: RedisClusterClientOptions,
  handlers?: { onError?: (err: Error) => void }
): Cluster {
  const startupNodeLookup = options.spreadStartupNodes
    ? createStartupNodeLookup(
        options.spreadStartupNodes === true ? undefined : options.spreadStartupNodes
      )
    : undefined;
  const client = new Redis.Cluster(options.nodes, {
    // The offline queue is a CLUSTER-level setting, separate from the per-node one below. While a
    // cluster cannot refresh its slot cache it queues commands here, so a caller that wants a
    // failure during an outage rather than a wait has to turn THIS one off. Default stays `true`,
    // matching ioredis, so only a caller that asks for it changes behaviour.
    ...(options.failFast && { enableOfflineQueue: false }),
    ...options.clusterOptions,
    ...(startupNodeLookup && { dnsLookup: startupNodeLookup.dnsLookup }),
    redisOptions: {
      ...defaultOptions,
      ...(options.failFast && { enableOfflineQueue: false }),
      ...options.redisOptions,
    },
  });

  if (startupNodeLookup) {
    // A failed slot-map read from a startup node arrives here keyed by the address it was given.
    client.on("node error", (_error: Error, node: string) => startupNodeLookup.markFailed(node));
    keepClusterConnecting(client);
    client.on("ready", () => {
      const summary = startupNodeLookup.takeSkipSummary();
      if (!summary) return;
      // warn: once per connect, and it means the startup hostname still lists a failed node.
      logger.warn("Redis cluster client connected after skipping recently failed nodes", summary);
      if (typeof options.spreadStartupNodes === "object") {
        options.spreadStartupNodes.onSkipSummary?.(summary);
      }
    });
  }

  if (process.env.VITEST) {
    client.on("error", () => {});
    return client;
  }

  client.on("error", (error) => {
    if (handlers?.onError) {
      handlers.onError(error);
    } else {
      logger.error(`Redis cluster client error:`, {
        error,
        keyPrefix: options.redisOptions?.keyPrefix,
      });
    }
  });

  // A failed slot refresh only surfaces as ClusterAllFailedError; each node's own failure, and
  // which node it was, arrives here.
  client.on("node error", (error: Error, node: string) => {
    logger.warn(`Redis cluster node error:`, { node, error: error.message });
  });

  return client;
}
