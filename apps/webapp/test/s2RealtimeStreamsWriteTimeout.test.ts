// The signal writes (append, stream config) run inside a promote, a deploy finalize and the
// threshold set and clear actions: an S2 that never answers must fail them after a bound, so the
// sync logs and the HTTP response goes out.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";

describe("S2RealtimeStreams writes against an S2 that never answers", () => {
  let server: Server;
  let endpoint: string;

  beforeAll(async () => {
    // Accepts every request and never writes a response.
    server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function streams() {
    return new S2RealtimeStreams({
      basin: "test-basin",
      accessToken: "test-token",
      endpoint,
      skipAccessTokens: true,
      logLevel: "error",
    });
  }

  // Catches: appendIfNextSeq with no timeout holding a promote's response open forever.
  it("appendIfNextSeq rejects after its timeout", { timeout: 15_000 }, async () => {
    const started = Date.now();
    await expect(streams().appendIfNextSeq("env/signals", [{ body: "{}" }], 0)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  // Catches: keepStreamUntilTrimmed with no timeout holding a threshold set open forever.
  it("keepStreamUntilTrimmed rejects after its timeout", { timeout: 15_000 }, async () => {
    const started = Date.now();
    await expect(streams().keepStreamUntilTrimmed("env/signals")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
