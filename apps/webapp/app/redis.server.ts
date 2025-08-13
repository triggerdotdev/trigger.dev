import { Cluster, Redis, type ClusterNode, type ClusterOptions } from "ioredis";
import { logger } from "./services/logger.server";

export type RedisWithClusterOptions = {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  tlsDisabled?: boolean;
  clusterMode?: boolean;
  clusterOptions?: Omit<ClusterOptions, "redisOptions">;
  keyPrefix?: string;
};

export type RedisClient = Redis | Cluster;

export function createRedisClient(
  connectionName: string,
  options: RedisWithClusterOptions
): Redis | Cluster {
  let redis: Redis | Cluster;

  if (options.clusterMode) {
    const nodes: ClusterNode[] = [
      {
        host: options.host,
        port: options.port,
      },
    ];

    logger.debug("Creating a redis cluster client", {
      connectionName,
      host: options.host,
      port: options.port,
    });

    redis = new Redis.Cluster(nodes, {
      ...options.clusterOptions,
      redisOptions: {
        connectionName,
        keyPrefix: options.keyPrefix,
        username: options.username,
        password: options.password,
        enableAutoPipelining: true,
        family: 0, // Support both IPv4 and IPv6 (required for Railway internal DNS)
        ...(options.tlsDisabled
          ? {
              checkServerIdentity: () => {
                // disable TLS verification
                return undefined;
              },
            }
          : { tls: {} }),
      },
      dnsLookup: (address, callback) => callback(null, address),
      slotsRefreshTimeout: 10000,
    });
  } else {
    logger.debug("Creating a redis client", {
      connectionName,
      host: options.host,
      port: options.port,
    });

    redis = new Redis({
      connectionName,
      host: options.host,
      port: options.port,
      username: options.username,
      password: options.password,
      enableAutoPipelining: true,
      keyPrefix: options.keyPrefix,
      family: 0, // Support both IPv4 and IPv6 (required for Railway internal DNS)
      ...(options.tlsDisabled ? {} : { tls: {} }),
    });
  }

  redis.on("error", (error) => {
    logger.error("Redis client error", { connectionName, error });
  });

  return redis;
}
