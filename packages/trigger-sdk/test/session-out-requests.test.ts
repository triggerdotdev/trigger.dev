import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  apiClientManager,
  trimSessionStream,
  writeSessionControlRecord,
} from "@trigger.dev/core/v3";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionOutputChannel } from "../src/v3/sessions.js";

/**
 * What a chat turn costs the server and the stream, counted against a local
 * stand-in for S2: requests to mint stream credentials (`initializeSessionStream`)
 * and appends to the stream. A turn writes three records through one-shot
 * appends: its start marker, its boundary and the trim behind it.
 */

let server: Server;
let endpoint = "";
let appends = 0;

/** An S2 `AppendAck` in protobuf: start, end and tail positions, each `{ seq_num, timestamp }`. */
function appendAckProtobuf(seq: number): Buffer {
  const position = (seqNum: number) => Buffer.from([0x08, seqNum, 0x10, 1]);
  const field = (number: number, bytes: Buffer) =>
    Buffer.concat([Buffer.from([(number << 3) | 2, bytes.length]), bytes]);
  return Buffer.concat([
    field(1, position(seq)),
    field(2, position(seq + 1)),
    field(3, position(seq + 1)),
  ]);
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      appends++;
      const protobuf = String(request.headers["content-type"] ?? "").includes("protobuf");
      const payload = protobuf
        ? appendAckProtobuf(appends)
        : Buffer.from(
            JSON.stringify({
              start: { seq_num: appends, timestamp: 1 },
              end: { seq_num: appends + 1, timestamp: 1 },
              tail: { seq_num: appends + 1, timestamp: 1 },
            })
          );
      response.writeHead(200, {
        "Content-Type": protobuf ? "application/protobuf" : "application/json",
        "Content-Length": payload.length,
      });
      response.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  appends = 0;
  vi.restoreAllMocks();
});

function installApiClient() {
  const initializeSessionStream = vi.fn(async () => ({
    headers: {
      "x-s2-access-token": "token",
      "x-s2-basin": "test-basin",
      "x-s2-stream-name": "chat-stream",
      "x-s2-endpoint": endpoint,
    },
  }));
  const client = { initializeSessionStream } as unknown as ReturnType<
    typeof apiClientManager.clientOrThrow
  >;
  vi.spyOn(apiClientManager, "clientOrThrow").mockReturnValue(client);
  return { client, initializeSessionStream };
}

const TURNS = 5;

describe("what a chat turn costs the server and the stream", () => {
  it("mints credentials once for the whole run, then appends three records per turn", async () => {
    // Catches: every start marker, boundary and trim asking the server for fresh
    // stream credentials: a request per record on top of the append.
    const { initializeSessionStream } = installApiClient();
    const channel = new SessionOutputChannel("chat-cost");

    for (let turn = 0; turn < TURNS; turn++) {
      await channel.writeControl("turn-start", [["turn-start-in-seq", String(turn)]]);
      await channel.writeControl("turn-complete");
      await channel.trimTo(turn);
    }

    expect(initializeSessionStream).toHaveBeenCalledTimes(1);
    expect(appends).toBe(3 * TURNS);
  });

  it("(for comparison) a boundary and a trim that each mint credentials cost two requests per turn", async () => {
    // The shape before turn markers: no cached credentials, no start marker.
    const { client, initializeSessionStream } = installApiClient();

    for (let turn = 0; turn < TURNS; turn++) {
      await writeSessionControlRecord(client as never, "chat-cost", "out", "turn-complete");
      await trimSessionStream(client as never, "chat-cost", turn);
    }

    expect(initializeSessionStream).toHaveBeenCalledTimes(2 * TURNS);
    expect(appends).toBe(2 * TURNS);
  });
});
