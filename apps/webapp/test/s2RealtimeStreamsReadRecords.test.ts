import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";

const batch = (seq: number) =>
  `event: batch\ndata: ${JSON.stringify({
    records: [
      { seq_num: seq, timestamp: 1, body: JSON.stringify({ data: `d${seq}`, id: `r${seq}` }) },
    ],
  })}\n\n`;
const errorEvent = "event: error\ndata: Reconnection required\n\n";

describe("S2RealtimeStreams.readRecords", () => {
  let server: Server;
  let endpoint: string;
  let bodies: string[];
  let reads: number;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      const body = bodies[Math.min(reads, bodies.length - 1)]!;
      reads++;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}/v1`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    reads = 0;
  });

  function createReader() {
    return new S2RealtimeStreams({
      basin: "test-basin",
      accessToken: "test-token",
      endpoint,
      skipAccessTokens: true,
      logLevel: "error",
    });
  }

  it("returns the records of a completed read", async () => {
    bodies = [batch(0) + batch(1) + "data: [DONE]\n\n"];

    await expect(createReader().readRecords("run_1", "chat")).resolves.toEqual([
      { data: "d0", id: "r0", seqNum: 0, headers: undefined },
      { data: "d1", id: "r1", seqNum: 1, headers: undefined },
    ]);
    expect(reads).toBe(1);
  });

  it("retries a read that S2 ends with an error event", async () => {
    bodies = [batch(0) + errorEvent, batch(0) + batch(1) + "data: [DONE]\n\n"];

    const records = await createReader().readRecords("run_1", "chat");

    expect(records.map((record) => record.seqNum)).toEqual([0, 1]);
    expect(reads).toBe(2);
  });

  it("rejects once error events outlast the retries", async () => {
    bodies = [batch(0) + errorEvent];

    await expect(createReader().readRecords("run_1", "chat")).rejects.toThrow(
      "Reconnection required"
    );
    expect(reads).toBe(3);
  });
});
