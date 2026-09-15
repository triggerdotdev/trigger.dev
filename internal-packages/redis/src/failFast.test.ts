import { describe, expect, it } from "vitest";
import { createRedisClient } from "./index.js";

// A snapshot-store append sits on a request path. With the offline queue enabled and no command
// timeout, a command issued while the endpoint is unreachable waits for a reconnect instead of
// failing, so the request hangs rather than falling back to Postgres.
describe("fail-fast options against an unreachable endpoint", () => {
  it("rejects rather than hanging when the offline queue is off and a timeout is set", async () => {
    const client = createRedisClient({
      // Nothing listens here.
      host: "127.0.0.1",
      port: 6390,
      enableOfflineQueue: false,
      commandTimeout: 300,
      lazyConnect: true,
      retryStrategy: () => null,
    });

    const started = Date.now();
    await expect(client.get("anything")).rejects.toThrow();
    const elapsed = Date.now() - started;

    // Generous, but far below the indefinite wait the offline queue produces.
    expect(elapsed).toBeLessThan(3000);

    client.disconnect();
  });
});
