import {
  Cluster,
  createRedisClient,
  createRedisClusterClient,
  type RedisClient,
  type RedisClusterClientOptions,
  type RedisOptions,
} from "@internal/redis";

/**
 * Where a fair queue keeps its state: one Redis node, or a cluster. A cluster only works with a key
 * producer that keeps every key a script touches in one slot, such as
 * `TenantShardedFairQueueKeyProducer`. The cluster's key prefix goes in `clusterOptions.keyPrefix`.
 */
export type FairQueueRedisOptions = RedisOptions | { cluster: RedisClusterClientOptions };

export function isClusterConnection(
  options: FairQueueRedisOptions
): options is { cluster: RedisClusterClientOptions } {
  return "cluster" in options && options.cluster !== undefined;
}

export function createFairQueueRedisClient(options: FairQueueRedisOptions): RedisClient {
  return isClusterConnection(options)
    ? createRedisClusterClient(options.cluster)
    : createRedisClient(options);
}

export function keyPrefixOf(options: FairQueueRedisOptions): string {
  return isClusterConnection(options)
    ? (options.cluster.clusterOptions?.keyPrefix ?? "")
    : (options.keyPrefix ?? "");
}

/**
 * Every key matching `pattern` (which must include the key prefix), page by page. A cluster doesn't
 * fan SCAN out to its nodes, so this scans each primary in turn.
 */
export async function* scanKeys(
  client: RedisClient,
  pattern: string,
  count = 1000
): AsyncGenerator<string[]> {
  const nodes = client instanceof Cluster ? client.nodes("master") : [client];
  for (const node of nodes) {
    let cursor = "0";
    do {
      const [next, keys] = await node.scan(cursor, "MATCH", pattern, "COUNT", count);
      cursor = next;
      if (keys.length > 0) yield keys;
    } while (cursor !== "0");
  }
}
