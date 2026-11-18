import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { RequestBodyTooLargeError, getJsonBody } from "../apps/http.js";
import { HttpServer, MAX_BODY_SIZE_CEILING, type BodySizeLimitMode } from "./httpServer.js";

type PostOptions = {
  chunks: Buffer[];
  contentLength?: number;
};

function post(port: number, path: string, { chunks, contentLength }: PostOptions) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(contentLength !== undefined ? { "content-length": String(contentLength) } : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );

    req.on("error", reject);

    for (const chunk of chunks) {
      req.write(chunk);
    }

    req.end();
  });
}

function jsonBody(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}

describe("HttpServer request bodies", () => {
  let server: HttpServer | undefined;

  afterEach(async () => {
    server?.server.closeAllConnections();
    await server?.stop();
    server = undefined;
  });

  async function startServer(
    options: {
      maxBodySize?: number;
      routeMaxBodySize?: number;
      bodySizeLimitMode?: BodySizeLimitMode;
    } = {}
  ) {
    const received: unknown[] = [];

    server = new HttpServer({
      port: 0,
      host: "127.0.0.1",
      maxBodySize: options.maxBodySize,
      bodySizeLimitMode: options.bodySizeLimitMode,
    })
      .route("/echo", "POST", {
        bodySchema: z.object({ value: z.string() }),
        maxBodySize: options.routeMaxBodySize,
        handler: async ({ body, reply }) => {
          received.push(body);
          reply.json({ value: body.value });
        },
      })
      .route("/ping", "POST", {
        handler: async ({ body, reply }) => {
          received.push(body);
          reply.text("pong");
        },
      });

    await server.start();

    const { port } = server.server.address() as AddressInfo;
    return { port, received };
  }

  // Catches: a body within the limit no longer reaching the handler.
  it("parses a JSON body within the size limit", async () => {
    const { port, received } = await startServer({ maxBodySize: 1024 });

    const res = await post(port, "/echo", { chunks: [jsonBody({ value: "hello" })] });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ value: "hello" });
    expect(received).toEqual([{ value: "hello" }]);
  });

  // Catches: a declared content length over the limit being read anyway.
  it("responds 413 when the declared content length is over the limit", async () => {
    const { port, received } = await startServer({ maxBodySize: 1024 });
    const body = jsonBody({ value: "a".repeat(4096) });

    const res = await post(port, "/echo", { chunks: [body], contentLength: body.byteLength });

    expect(res.status).toBe(413);
    expect(received).toEqual([]);
  });

  // Catches: a chunked body without a content length bypassing the limit.
  it("responds 413 when a chunked body grows past the limit", async () => {
    const { port, received } = await startServer({ maxBodySize: 1024 });
    const chunks = Array.from({ length: 64 }, () => Buffer.alloc(256, "a"));

    const res = await post(port, "/echo", { chunks });

    expect(res.status).toBe(413);
    expect(received).toEqual([]);
  });

  // Catches: an off-by-one at the limit boundary.
  it("accepts a body of exactly the limit", async () => {
    const body = jsonBody({ value: "a".repeat(100) });
    const { port } = await startServer({ maxBodySize: body.byteLength });

    const res = await post(port, "/echo", { chunks: [body] });

    expect(res.status).toBe(200);
  });

  // Catches: the per-route limit being ignored.
  it("uses the route limit over the server limit", async () => {
    const { port } = await startServer({ maxBodySize: 64, routeMaxBodySize: 8192 });

    const res = await post(port, "/echo", { chunks: [jsonBody({ value: "a".repeat(4096) })] });

    expect(res.status).toBe(200);
  });

  // Catches: routes without a body schema reading the body.
  it("does not parse bodies for routes without a body schema", async () => {
    const { port, received } = await startServer({ maxBodySize: 64 });

    const res = await post(port, "/ping", { chunks: [jsonBody({ value: "a".repeat(4096) })] });

    expect(res.status).toBe(200);
    expect(received).toEqual([undefined]);
  });

  // Catches: shadow mode refusing a body between the limit and the ceiling.
  it("serves bodies over the limit in shadow mode", async () => {
    const { port, received } = await startServer({ maxBodySize: 64, bodySizeLimitMode: "shadow" });

    const res = await post(port, "/echo", { chunks: [jsonBody({ value: "a".repeat(4096) })] });

    expect(res.status).toBe(200);
    expect(received).toEqual([{ value: "a".repeat(4096) }]);
  });

  // Catches: a configured limit above the ceiling raising the ceiling.
  it.each<BodySizeLimitMode>(["shadow", "enforce"])(
    "responds 413 above the ceiling in %s mode when the route limit is higher",
    async (bodySizeLimitMode) => {
      const { port, received } = await startServer({
        routeMaxBodySize: MAX_BODY_SIZE_CEILING * 2,
        bodySizeLimitMode,
      });
      const chunks = Array.from({ length: 33 }, () => Buffer.alloc(1024 * 1024, "a"));

      const res = await post(port, "/echo", { chunks });

      expect(res.status).toBe(413);
      expect(received).toEqual([]);
    }
  );

  // Catches: shadow mode with no upper bound on a declared content length.
  it("responds 413 in shadow mode when the declared content length is over the ceiling", async () => {
    const { port, received } = await startServer({ maxBodySize: 64, bodySizeLimitMode: "shadow" });

    const res = await post(port, "/echo", {
      chunks: [jsonBody({ value: "a" })],
      contentLength: MAX_BODY_SIZE_CEILING + 1,
    });

    expect(res.status).toBe(413);
    expect(received).toEqual([]);
  });

  // Catches: shadow mode with no upper bound on a chunked body.
  it("responds 413 in shadow mode when a chunked body grows past the ceiling", async () => {
    const { port, received } = await startServer({ maxBodySize: 64, bodySizeLimitMode: "shadow" });
    const chunks = Array.from({ length: 33 }, () => Buffer.alloc(1024 * 1024, "a"));

    const res = await post(port, "/echo", { chunks });

    expect(res.status).toBe(413);
    expect(received).toEqual([]);
  });
});

describe("getJsonBody", () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
    server = undefined;
  });

  async function startServer(maxBytes?: number) {
    const results: Promise<unknown>[] = [];
    let firstChunkSeen!: () => void;
    const firstChunk = new Promise<void>((resolve) => (firstChunkSeen = resolve));

    server = createServer((req, res) => {
      req.once("data", () => firstChunkSeen());
      const result = getJsonBody(req, { maxBytes });
      results.push(result);
      result.then(
        () => res.writeHead(200).end(),
        () => res.writeHead(400).end()
      );
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));

    const { port } = server.address() as AddressInfo;
    return { port, results, firstChunk };
  }

  // Catches: multi-byte characters corrupted when they span two chunks.
  it("decodes multi-byte characters split across chunks", async () => {
    const { port, results, firstChunk } = await startServer();
    const bytes = Buffer.from(JSON.stringify({ value: "héllo ✓" }));
    // Byte 12 is the second byte of "é".
    const splitAt = bytes.indexOf(Buffer.from("é")) + 1;

    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/",
      headers: { "content-length": String(bytes.byteLength) },
    });
    req.on("response", (res) => res.resume());
    req.flushHeaders();
    req.write(bytes.subarray(0, splitAt));
    await firstChunk;
    req.end(bytes.subarray(splitAt));

    await expect(results[0]).resolves.toEqual({ value: "héllo ✓" });
  });

  // Catches: the body limit not applying when getJsonBody is called directly.
  it("rejects once the body is larger than maxBytes", async () => {
    const { port, results } = await startServer(10);

    await post(port, "/", { chunks: [Buffer.alloc(8, "a"), Buffer.alloc(8, "a")] });

    await expect(results[0]).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  // Catches: the returned promise never settling when the client goes away mid-body.
  it("rejects when the request closes before the body ends", async () => {
    const { port, results } = await startServer();

    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"value":'
    );

    await expect.poll(() => results.length).toBe(1);
    socket.destroy();

    await expect(results[0]).rejects.toThrow();
  });
});
