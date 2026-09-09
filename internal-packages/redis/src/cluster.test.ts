import { describe, expect, it } from "vitest";
import { Cluster, createRedisClusterClient, defaultReconnectOnError } from "./index.js";

// Port 6399 is deliberately closed: these assertions are about the client the factory builds, not
// about a connection.
const NODES = [{ host: "127.0.0.1", port: 6399 }];

type InnerOptions = {
  options: {
    redisOptions?: {
      reconnectOnError?: unknown;
      maxRetriesPerRequest?: number;
      retryStrategy?: unknown;
      keyPrefix?: string;
    };
  };
};

function innerOptionsOf(client: Cluster) {
  return (client as unknown as InnerOptions).options.redisOptions;
}

describe("createRedisClusterClient", () => {
  it("returns a Cluster instance", async () => {
    const client = createRedisClusterClient({ nodes: NODES });
    try {
      expect(client).toBeInstanceOf(Cluster);
    } finally {
      await client.quit().catch(() => undefined);
    }
  });

  it("installs defaultReconnectOnError on the inner per-node options", async () => {
    const client = createRedisClusterClient({ nodes: NODES });
    try {
      expect(innerOptionsOf(client)?.reconnectOnError).toBe(defaultReconnectOnError);
    } finally {
      await client.quit().catch(() => undefined);
    }
  });

  it("carries the retry defaults onto the inner options", async () => {
    const client = createRedisClusterClient({ nodes: NODES });
    try {
      const inner = innerOptionsOf(client);
      expect(inner?.maxRetriesPerRequest).toBeTypeOf("number");
      expect(inner?.retryStrategy).toBeTypeOf("function");
    } finally {
      await client.quit().catch(() => undefined);
    }
  });

  it("lets caller redisOptions override the defaults", async () => {
    const client = createRedisClusterClient({
      nodes: NODES,
      redisOptions: { keyPrefix: "engine:", maxRetriesPerRequest: 3 },
    });
    try {
      const inner = innerOptionsOf(client);
      expect(inner?.keyPrefix).toBe("engine:");
      expect(inner?.maxRetriesPerRequest).toBe(3);
    } finally {
      await client.quit().catch(() => undefined);
    }
  });

  it("keeps mapping READONLY, LOADING and UNBLOCKED to a reconnect-and-retry", () => {
    expect(defaultReconnectOnError(new Error("READONLY against a read only replica"))).toBe(2);
    expect(defaultReconnectOnError(new Error("LOADING Redis is loading the dataset"))).toBe(2);
    expect(defaultReconnectOnError(new Error("UNBLOCKED force unblock"))).toBe(2);
    expect(defaultReconnectOnError(new Error("ERR unknown command"))).toBe(false);
  });
});
