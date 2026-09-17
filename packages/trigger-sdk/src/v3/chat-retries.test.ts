import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChatTransport, type ChatTransportEvent, type TriggerChatTransport } from "./chat.js";

describe("Chat subscription retry exhaustion", () => {
  let server: Server;
  let baseURL: string;
  let transport: TriggerChatTransport;
  let attempts: number;
  let respond: (response: ServerResponse, request: IncomingMessage) => void;
  let events: ChatTransportEvent[];

  beforeEach(async () => {
    attempts = 0;
    events = [];
    server = createServer((request, response) => {
      attempts++;
      respond(response, request);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    baseURL = `http://127.0.0.1:${address.port}`;
    transport = createChatTransport({
      task: "chat-task",
      baseURL,
      sessions: { chat: { publicAccessToken: "test-token", isStreaming: true } },
      accessToken: () => "test-token",
      onEvent: (event) => events.push(event),
    });
  });

  afterEach(async () => {
    transport.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("clears persisted streaming state after a terminal authorization failure", async () => {
    respond = (response) => response.writeHead(401).end();
    const stream = await transport.reconnectToStream({ chatId: "chat" });
    if (!stream) throw new Error("Expected a resumed stream");

    await expect(stream.getReader().read()).rejects.toMatchObject({ status: 401 });
    expect(attempts).toBe(2);
    expect(transport.getSession("chat")?.isStreaming).toBe(false);
    expect(await transport.reconnectToStream({ chatId: "chat" })).toBeNull();
    expect(events.filter((event) => event.type === "stream-error")).toHaveLength(1);
  });

  it("limits failed connections and reports a terminal stream error", async () => {
    respond = (response) => response.writeHead(503).end();
    const stream = await transport.reconnectToStream({ chatId: "chat" });
    if (!stream) throw new Error("Expected a resumed stream");

    await expect(stream.getReader().read()).rejects.toMatchObject({ status: 503 });
    expect(attempts).toBe(6);
    expect(transport.getSession("chat")?.isStreaming).toBe(false);
    expect(await transport.reconnectToStream({ chatId: "chat" })).toBeNull();
    expect(events.filter((event) => event.type === "stream-error")).toHaveLength(1);
  }, 25_000);

  it("preserves unlimited retries for watch subscriptions", async () => {
    transport.dispose();
    transport = createChatTransport({
      task: "chat-task",
      baseURL,
      watch: true,
      sessions: { chat: { publicAccessToken: "test-token", isStreaming: true } },
      accessToken: () => "test-token",
    });
    respond = (response) => {
      if (attempts <= 6) {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('id: 1\ndata: {"type":"start","messageId":"assistant"}\n\n');
    };
    const stream = await transport.reconnectToStream({ chatId: "chat" });
    if (!stream) throw new Error("Expected a resumed stream");
    const reader = stream.getReader();

    expect(await reader.read()).toMatchObject({ done: false, value: { type: "start" } });
    expect(attempts).toBe(7);
    await reader.cancel();
  }, 12_000);

  it.each(["resolve", "reject"] as const)(
    "keeps the new stream after a late token refresh: %s",
    async (outcome) => {
      let releaseToken!: (token: string) => void;
      let rejectToken!: (error: Error) => void;
      const token = new Promise<string>((resolve, reject) => {
        releaseToken = resolve;
        rejectToken = reject;
      });
      let notifyRefresh!: () => void;
      const refreshing = new Promise<void>((resolve) => {
        notifyRefresh = resolve;
      });
      transport.dispose();
      transport = createChatTransport({
        task: "chat-task",
        baseURL,
        sessions: { chat: { publicAccessToken: "test-token", isStreaming: true } },
        accessToken: () => {
          notifyRefresh();
          return token;
        },
      });
      respond = (response, request) => {
        if (request.method === "POST") {
          response.writeHead(200, { "Content-Type": "application/json" }).end('{"seq_num":50}');
        } else if (attempts === 1 || request.headers.authorization === "Bearer refreshed-token") {
          response.writeHead(401).end();
        } else {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write('id: 51\ndata: {"type":"start","messageId":"replacement"}\n\n');
        }
      };
      const oldStream = await transport.reconnectToStream({ chatId: "chat" });
      if (!oldStream) throw new Error("Expected a resumed stream");
      const oldRead = oldStream
        .getReader()
        .read()
        .catch((error: unknown) => error);
      await refreshing;
      const replacement = await transport.sendMessages({
        chatId: "chat",
        trigger: "submit-message",
        messageId: "user",
        messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "Continue" }] }],
        abortSignal: undefined,
      });
      const reader = replacement.getReader();
      expect(await reader.read()).toMatchObject({
        done: false,
        value: { messageId: "replacement" },
      });

      if (outcome === "resolve") {
        releaseToken("refreshed-token");
        expect(await oldRead).toEqual({ done: true, value: undefined });
      } else {
        const error = new Error("Token refresh failed");
        rejectToken(error);
        expect(await oldRead).toBe(error);
      }
      expect(transport.getSession("chat")?.isStreaming).toBe(true);
      await reader.cancel();
    }
  );
});
