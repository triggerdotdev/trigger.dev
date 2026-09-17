import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SSEStreamSubscription } from "./runStream.js";

describe("SSE retry exhaustion", () => {
  let server: Server;
  let url: string;
  let abort: AbortController;
  let attempts: number;
  let respond: (response: ServerResponse) => void;
  let subscription: SSEStreamSubscription;

  beforeEach(async () => {
    attempts = 0;
    abort = new AbortController();
    server = createServer((_request, response) => {
      attempts++;
      respond(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function open(
    options: {
      fetchTimeoutMs?: number;
      stallTimeoutMs?: number;
      maxRetries?: number;
      maxStallRetries?: number;
    } = {}
  ) {
    subscription = new SSEStreamSubscription(url, {
      signal: abort.signal,
      maxRetries: 2,
      retryDelayMs: 1,
      retryJitter: 0,
      ...options,
    });
    return (await subscription.subscribe()).getReader();
  }

  it.each(["fetch", "stall"] as const)(
    "reports exhausted %s timeouts as failures",
    async (failure) => {
      respond = (response) => {
        if (failure === "stall") {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.flushHeaders();
        }
      };
      const reader = await open({
        fetchTimeoutMs: failure === "fetch" ? 100 : 1_000,
        stallTimeoutMs: 100,
      });

      await expect(reader.read()).rejects.toMatchObject({
        name: "Error",
        message: "Stream connection retries exhausted",
      });
      expect(attempts).toBe(3);
    }
  );

  it.each([
    ["comment", ": keepalive\n\n"],
    ["keepalive event", "event: keepalive\ndata: {}\n\n"],
    ["empty batch", 'event: batch\ndata: {"records":[]}\n\n'],
  ])("does not reset the retry budget after a %s", async (_name, payload) => {
    respond = (response) => {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Stream-Version": "v2",
      });
      response.write(payload);
    };
    const reader = await open({ stallTimeoutMs: 100, maxRetries: Infinity, maxStallRetries: 2 });

    await expect(reader.read()).rejects.toThrow("Stream connection retries exhausted");
    expect(attempts).toBe(3);
  });

  it("restores the retry budget after a decoded record", async () => {
    respond = (response) => {
      if (attempts !== 3) {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('id: 1\ndata: {"hello":1}\n\n');
    };
    const reader = await open({ stallTimeoutMs: 100 });

    expect(await reader.read()).toMatchObject({ done: false, value: { chunk: { hello: 1 } } });
    await expect(reader.read()).rejects.toMatchObject({ status: 503 });
    expect(attempts).toBe(5);
  });

  it("closes without retries when the caller cancels", async () => {
    respond = () => abort.abort();
    const reader = await open();

    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(attempts).toBe(1);
  });

  it("limits silent stalls without a general retry limit", async () => {
    respond = (response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
    };
    const reader = await open({ stallTimeoutMs: 100, maxRetries: Infinity, maxStallRetries: 2 });

    await expect(reader.read()).rejects.toThrow("Stream connection retries exhausted");
    expect(attempts).toBe(3);
  });

  it("restores the stall budget only after a decoded record", async () => {
    respond = (response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
      if (attempts === 3) response.write('id: 1\ndata: {"hello":1}\n\n');
    };
    const reader = await open({ stallTimeoutMs: 100, maxRetries: Infinity, maxStallRetries: 2 });

    expect(await reader.read()).toMatchObject({ done: false, value: { chunk: { hello: 1 } } });
    await expect(reader.read()).rejects.toThrow("Stream connection retries exhausted");
    expect(attempts).toBe(5);
  });

  it.each(["http", "fetch", "body", "wake"] as const)(
    "does not charge %s failures to the stall budget",
    async (failure) => {
      respond = (response) => {
        if (attempts === 5) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end('id: 1\ndata: {"hello":1}\n\n');
        } else if (failure === "http") {
          response.writeHead(503).end();
        } else if (failure !== "fetch") {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write(": keepalive\n\n");
          setTimeout(() => {
            if (failure === "wake") subscription.forceReconnect();
            else response.destroy();
          }, 10);
        }
      };
      const reader = await open({
        maxRetries: Infinity,
        maxStallRetries: 0,
        fetchTimeoutMs: 100,
        stallTimeoutMs: 1_000,
      });

      expect(await reader.read()).toMatchObject({ done: false, value: { chunk: { hello: 1 } } });
      expect(attempts).toBe(5);
    }
  );

  it("retains the stall budget across connection failures and wakeups", async () => {
    respond = (response) => {
      if (attempts === 2) {
        response.writeHead(503).end();
      } else if (attempts !== 4) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.flushHeaders();
        if (attempts === 3) setTimeout(() => subscription.forceReconnect(), 10);
      }
    };
    const reader = await open({
      maxRetries: Infinity,
      maxStallRetries: 1,
      fetchTimeoutMs: 100,
      stallTimeoutMs: 100,
    });

    await expect(reader.read()).rejects.toThrow("Stream connection retries exhausted");
    expect(attempts).toBe(5);
  });
});
