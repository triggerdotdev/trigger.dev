import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryTriggerChatRunStore,
  TriggerChatTransport,
} from "./chatTransport.js";
import type { UIMessage, UIMessageChunk } from "ai";

type TestServer = {
  url: string;
  close: () => Promise<void>;
};

const activeServers: TestServer[] = [];

afterEach(async function () {
  while (activeServers.length > 0) {
    const server = activeServers.pop();
    if (server) {
      await server.close();
    }
  }
});

describe("TriggerChatTransport", function () {
  it("triggers task and streams chunks with rich default payload", async function () {
    let receivedTriggerBody: Record<string, unknown> | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        readJsonBody(req).then(function (body) {
          receivedTriggerBody = body;
          res.writeHead(200, {
            "content-type": "application/json",
            "x-trigger-jwt": "pk_run_123",
          });
          res.end(JSON.stringify({ id: "run_123" }));
        });
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_123/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "msg_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-delta", id: "msg_1", delta: "Hello" })
        );
        writeSSE(
          res,
          "3-0",
          JSON.stringify({ type: "text-end", id: "msg_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-1",
      messageId: undefined,
      messages: [
        {
          id: "usr_1",
          role: "user",
          parts: [{ type: "text", text: "Hello there" }],
        } satisfies UIMessage,
      ],
      abortSignal: undefined,
      headers: new Headers([["x-test-header", "abc123"]]),
      body: { tenantId: "tenant_1" },
      metadata: { source: "unit-test" },
    });

    const chunks = await readChunks(stream);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      type: "text-start",
      chunk: { type: "text-start", id: "msg_1" },
    });
    expect(chunks[1]).toMatchObject({
      type: "text-delta",
      chunk: { type: "text-delta", id: "msg_1", delta: "Hello" },
    });
    expect(chunks[2]).toMatchObject({
      type: "text-end",
      chunk: { type: "text-end", id: "msg_1" },
    });

    expect(receivedTriggerBody).toBeDefined();

    const options = (receivedTriggerBody?.options ?? {}) as Record<string, unknown>;
    expect(options.payloadType).toBe("application/super+json");

    const payloadString = receivedTriggerBody?.payload as string;
    const payload = (JSON.parse(payloadString) as { json: Record<string, unknown> }).json;

    expect(payload.chatId).toBe("chat-1");
    expect(payload.trigger).toBe("submit-message");
    expect(payload.messageId).toBeNull();
    expect(payload.messages).toHaveLength(1);
    expect(payload.request).toEqual({
      headers: {
        "x-test-header": "abc123",
      },
      body: { tenantId: "tenant_1" },
      metadata: { source: "unit-test" },
    });
  });

  it("returns null on reconnect when no active run exists", async function () {
    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: "https://api.trigger.dev",
    });

    const stream = await transport.reconnectToStream({
      chatId: "missing-chat",
    });

    expect(stream).toBeNull();
  });

  it("reconnects active streams using tracked lastEventId", async function () {
    let reconnectLastEventId: string | undefined;
    let firstStreamResponse: ServerResponse<IncomingMessage> | undefined;
    let firstStreamChunkSent = false;
    const runStore = new InMemoryTriggerChatRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_456",
        });
        res.end(JSON.stringify({ id: "run_456" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_456/chat-stream") {
        const lastEventId = req.headers["last-event-id"];
        const normalizedLastEventId = Array.isArray(lastEventId)
          ? lastEventId[0]
          : lastEventId;

        if (typeof normalizedLastEventId === "string") {
          reconnectLastEventId = normalizedLastEventId;
          res.writeHead(200, {
            "content-type": "text/event-stream",
          });
          writeSSE(
            res,
            "2-0",
            JSON.stringify({ type: "text-delta", id: "msg_2", delta: "world" })
          );
          writeSSE(
            res,
            "3-0",
            JSON.stringify({ type: "text-end", id: "msg_2" })
          );
          res.end();
          return;
        }

        firstStreamResponse = res;
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "msg_2" })
        );
        firstStreamChunkSent = true;
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
    });

    try {
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-2",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      });

      await waitForCondition(function () {
        if (!firstStreamChunkSent) {
          return false;
        }

        const state = runStore.get("chat-2");
        return Boolean(state && state.lastEventId === "0");
      });

      const reconnectStream = await transport.reconnectToStream({
        chatId: "chat-2",
      });

      expect(reconnectStream).not.toBeNull();

      const reconnectChunks = await readChunks(reconnectStream!);
      expect(reconnectLastEventId).toBe("0");
      expect(reconnectChunks).toHaveLength(2);
      expect(reconnectChunks[0]).toMatchObject({
        chunk: { type: "text-delta", id: "msg_2", delta: "world" },
      });
      expect(reconnectChunks[1]).toMatchObject({
        chunk: { type: "text-end", id: "msg_2" },
      });
    } finally {
      if (firstStreamResponse) {
        firstStreamResponse.end();
      }
    }
  });
});

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => void
) {
  const nodeServer = createServer(handler);

  await new Promise<void>(function (resolve) {
    nodeServer.listen(0, "127.0.0.1", function () {
      resolve();
    });
  });

  const address = nodeServer.address() as AddressInfo;
  const server: TestServer = {
    url: `http://127.0.0.1:${address.port}`,
    close: function () {
      if (typeof nodeServer.closeAllConnections === "function") {
        nodeServer.closeAllConnections();
      }

      return new Promise<void>(function (resolve, reject) {
        nodeServer.close(function (error) {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };

  activeServers.push(server);

  return server;
}

function writeSSE(res: ServerResponse<IncomingMessage>, id: string, data: string) {
  res.write(`id: ${id}\n`);
  res.write(`data: ${data}\n\n`);
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: string[] = [];
  for await (const chunk of req) {
    chunks.push(chunk.toString());
  }
  return JSON.parse(chunks.join("")) as Record<string, unknown>;
}

async function readChunks(stream: ReadableStream<UIMessageChunk>) {
  const parts: Array<{ type: string; id?: string; chunk: UIMessageChunk }> = [];
  for await (const chunk of stream) {
    const part: { type: string; id?: string; chunk: UIMessageChunk } = {
      type: chunk.type,
      chunk,
    };

    if ("id" in chunk && typeof chunk.id === "string") {
      part.id = chunk.id;
    }

    parts.push(part);
  }

  return parts;
}

async function waitForCondition(condition: () => boolean, timeoutInMs = 5000) {
  const start = Date.now();

  while (Date.now() - start < timeoutInMs) {
    if (condition()) {
      return;
    }

    await new Promise<void>(function (resolve) {
      setTimeout(resolve, 25);
    });
  }

  throw new Error(`Condition was not met within ${timeoutInMs}ms`);
}
