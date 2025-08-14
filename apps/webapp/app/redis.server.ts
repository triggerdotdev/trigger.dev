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

// Custom DNS lookup that supports both IPv4 and IPv6
function dnsLookup(address: string, callback: (err: Error | null, address?: string, family?: number) => void) {
  // Use Node.js DNS with dual-stack support (both IPv4 and IPv6)
  require("dns").lookup(address, { family: 0, all: false }, (err, resolvedAddress, family) => {
    if (err) {
      logger.error("DNS lookup failed", { address, error: err.message });
      callback(err);
    } else {
      logger.debug("DNS lookup successful", { 
        address, 
        resolved: resolvedAddress, 
        family: family === 6 ? 'IPv6' : 'IPv4' 
      });
      callback(null, resolvedAddress, family);
    }
  });
}

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
        family: 0, // Support both IPv4 and IPv6
        dnsLookup: dnsLookup, // Custom DNS resolution with dual-stack support
        ...(options.tlsDisabled
          ? {
              checkServerIdentity: () => {
                // disable TLS verification
                return undefined;
              },
            }
          : { tls: {} }),
      },
      dnsLookup: dnsLookup, // Also apply to cluster-level DNS lookups
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
      family: 0, // Support both IPv4 and IPv6
      dnsLookup: dnsLookup, // Custom DNS resolution with dual-stack support
      ...(options.tlsDisabled ? {} : { tls: {} }),
    });
  }

  redis.on("error", (error) => {
    logger.error("Redis client error", { connectionName, error });
  });

  return redis;
}
