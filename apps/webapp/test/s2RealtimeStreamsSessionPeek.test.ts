import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Logger } from "@trigger.dev/core/logger";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

describe("S2RealtimeStreams session peek", () => {
  let server: Server;
  let endpoint: string;
  let handler: Handler;

  beforeAll(async () => {
    server = createServer((request, response) => handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}/v1`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    handler = (_request, response) => {
      response.writeHead(404);
      response.end();
    };
  });

  function createStreams(logger?: Logger) {
    return new S2RealtimeStreams({
      basin: "test-basin",
      accessToken: "test-token",
      endpoint,
      skipAccessTokens: true,
      logLevel: "error",
      logger,
    });
  }

  function stallAfterHeaders(): Handler {
    return (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"records":[');
    };
  }

  it("logs a body that stalls past the timeout as timed out, not as a parse failure", async () => {
    handler = stallAfterHeaders();
    const logger = new Logger("test", "error");
    const warn = vi.spyOn(logger, "warn");
    const streams = createStreams(logger);

    await expect(streams.peekSessionOutTail("chat_1")).resolves.toEqual({ kind: "unknown" });
    await expect(streams.readSessionInTailSeq("chat_1")).resolves.toBeUndefined();

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "S2 peek last record: timed out",
      "S2 read tail: timed out",
    ]);
  });

  it("logs a malformed body as a parse failure", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("not json");
    };
    const logger = new Logger("test", "error");
    const warn = vi.spyOn(logger, "warn");

    await expect(createStreams(logger).peekSessionOutTail("chat_1")).resolves.toEqual({
      kind: "unknown",
    });

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "S2 peek last record: parse failed",
    ]);
  });

  it("reads a hung .out peek as unknown after the timeout", async () => {
    handler = () => {};

    const startedAt = Date.now();
    await expect(createStreams().peekSessionOutTail("chat_1")).resolves.toEqual({
      kind: "unknown",
    });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(5000);
  });

  it("reads the .out tail record past a trim command", async () => {
    handler = (request, response) => {
      expect(decodeURIComponent(request.url ?? "")).toContain("/sessions/chat_1/out/records?");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          records: [
            {
              seq_num: 7,
              timestamp: 1234,
              body: "",
              headers: [
                ["trigger-control", "turn-complete"],
                ["session-in-consumed-id", "4"],
              ],
            },
            { seq_num: 8, timestamp: 1235, body: "", headers: [["", "trim"]] },
          ],
        })
      );
    };

    await expect(createStreams().peekSessionOutTail("chat_1")).resolves.toEqual({
      kind: "record",
      control: "turn-complete",
      timestamp: 1234,
      inConsumedSeq: 4,
    });
  });

  it("reads the .in tail seq, with a missing stream as 0", async () => {
    let status = 200;
    handler = (request, response) => {
      expect(decodeURIComponent(request.url ?? "")).toContain("/sessions/chat_1/in/records/tail");
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(status === 200 ? JSON.stringify({ tail: { seq_num: 5, timestamp: 1 } }) : "");
    };

    await expect(createStreams().readSessionInTailSeq("chat_1")).resolves.toBe(5);
    status = 404;
    await expect(createStreams().readSessionInTailSeq("chat_1")).resolves.toBe(0);
    status = 500;
    await expect(createStreams().readSessionInTailSeq("chat_1")).resolves.toBeUndefined();
  });

  it("reads a hung .in tail as unknown after the timeout", async () => {
    handler = () => {};

    await expect(createStreams().readSessionInTailSeq("chat_1")).resolves.toBeUndefined();
  });
});
