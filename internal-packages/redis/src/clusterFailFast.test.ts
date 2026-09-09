import { describe, expect, it } from "vitest";
import { createRedisClusterClient } from "./index.js";

// The offline queue on a Cluster client is a CLUSTER-level option. Setting it on the inner
// per-node redisOptions leaves the cluster queueing commands while it cannot refresh its slot
// cache, so a command issued during an outage waits instead of failing and the caller hangs.
describe("cluster client against an unreachable cluster", () => {
  it("rejects a command rather than queueing it", async () => {
    const client = createRedisClusterClient({
      // Nothing listens here.
      nodes: [{ host: "127.0.0.1", port: 6391 }],
      redisOptions: { commandTimeout: 300 },
      failFast: true,
    });

    const started = Date.now();
    await expect(client.get("anything")).rejects.toThrow();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5000);

    client.disconnect();
  });
});
