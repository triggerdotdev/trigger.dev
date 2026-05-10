import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { simulateReadableStream, streamText } from "ai";
import type { UIMessageChunk } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

// Stub `SessionStreamInstance` so the handler's S2 tee is a no-op
// instead of trying to reach a real S2 endpoint. The real one calls
// `apiClient.initializeSessionStream` then pipes via S2 — both are
// out of scope for handler-shape tests.
vi.mock("@trigger.dev/core/v3", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  class StubSessionStreamInstance<T> {
    constructor(opts: { source: ReadableStream<T> }) {
      // Drain the source so the upstream tee doesn't backpressure-stall
      // the SSE half. We don't keep the chunks — durability/resume is
      // out of scope here.
      void (async () => {
        const reader = opts.source.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
      })();
    }
    async wait() {
      return { written: 0 };
    }
  }
  return { ...actual, SessionStreamInstance: StubSessionStreamInstance };
});

// Import AFTER the mock so chat-server picks up the stubbed class.
import { chat } from "./chat-server.js";
import { apiClientManager } from "@trigger.dev/core/v3";

// ── Helpers ────────────────────────────────────────────────────────────

function textStream(text: string): ReadableStream<LanguageModelV3StreamPart> {
  return simulateReadableStream({
    chunks: [
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: text },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
      },
    ],
  });
}

function toolCallStream(): ReadableStream<LanguageModelV3StreamPart> {
  return simulateReadableStream({
    chunks: [
      {
        type: "tool-call",
        toolCallId: "tc-1",
        toolName: "weather",
        input: JSON.stringify({ city: "tokyo" }),
      },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 0, reasoning: undefined },
        },
      },
    ],
  });
}

function makeRequest(body: unknown): Request {
  return new Request("https://my-app.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SESSION_PAT = "tr_session_pat_for_handover";

function createSessionResponse(externalId: string): Response {
  return new Response(
    JSON.stringify({
      id: "session_test",
      externalId,
      type: "chat.agent",
      taskIdentifier: "test-agent",
      triggerConfig: {
        basePayload: { chatId: externalId, trigger: "handover-prepare" },
        idleTimeoutInSeconds: 60,
      },
      currentRunId: "run_test",
      runId: "run_test",
      publicAccessToken: SESSION_PAT,
      tags: [],
      metadata: null,
      closedAt: null,
      closedReason: null,
      expiresAt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      isCached: false,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}

function appendOkResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function readSSEBodyToChunks(res: Response): Promise<UIMessageChunk[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)) as UIMessageChunk);
}

type CapturedRequest = { url: string; init?: RequestInit };

async function withApiContext<T>(fn: () => Promise<T>): Promise<T> {
  return apiClientManager.runWithConfig(
    {
      baseURL: "https://api.test.trigger.dev",
      secretKey: "tr_test_secret",
    },
    fn
  );
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("chat.headStart (route handler)", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("creates the session with handover-prepare in basePayload and returns the session PAT in headers", async () => {
    const requests: CapturedRequest[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      requests.push({ url: urlStr, init });
      if (urlStr.endsWith("/api/v1/sessions") || urlStr.endsWith("/api/v1/sessions/")) {
        return createSessionResponse("chat-1");
      }
      if (urlStr.includes("/realtime/v1/sessions/") && urlStr.endsWith("/in/append")) {
        return appendOkResponse();
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    });

    const handler = chat.headStart({
      agentId: "test-agent",
      run: async ({ chat: chatHelper }) => {
        return streamText({
          ...chatHelper.toStreamTextOptions(),
          model: new MockLanguageModelV3({
            doStream: async () => ({ stream: textStream("hi back") }),
          }),
        });
      },
    });

    const res = await withApiContext(() =>
      handler(
        makeRequest({
          chatId: "chat-1",
          trigger: "submit-message",
          headStartMessages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        })
      )
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Trigger-Chat-Id")).toBe("chat-1");
    expect(res.headers.get("X-Trigger-Chat-Access-Token")).toBe(SESSION_PAT);
    expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);

    const sessionCreate = requests.find((r) =>
      r.url.endsWith("/api/v1/sessions") || r.url.endsWith("/api/v1/sessions/")
    );
    expect(sessionCreate).toBeDefined();
    const body = JSON.parse(sessionCreate!.init!.body as string);
    expect(body.type).toBe("chat.agent");
    expect(body.externalId).toBe("chat-1");
    expect(body.taskIdentifier).toBe("test-agent");
    // The trigger payload is rewritten to handover-prepare even though the
    // browser sent submit-message — the agent boots into the handover wait branch.
    expect(body.triggerConfig.basePayload.trigger).toBe("handover-prepare");
    expect(body.triggerConfig.basePayload.chatId).toBe("chat-1");
    expect(body.triggerConfig.basePayload.idleTimeoutInSeconds).toBe(60);
  });

  it("dispatches handover with isFinal=true on pure-text finishReason", async () => {
    const requests: CapturedRequest[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      requests.push({ url: urlStr, init });
      if (urlStr.endsWith("/api/v1/sessions") || urlStr.endsWith("/api/v1/sessions/")) {
        return createSessionResponse("chat-final");
      }
      if (urlStr.includes("/realtime/v1/sessions/") && urlStr.endsWith("/in/append")) {
        return appendOkResponse();
      }
      // Stitched response subscribes to `.out` after handover.
      if (/\/realtime\/v1\/sessions\/[^/]+\/out$/.test(urlStr)) {
        return new Response(new ReadableStream({ start(c) { c.close(); } }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    });

    const handler = chat.headStart({
      agentId: "test-agent",
      run: async ({ chat: chatHelper }) => {
        return streamText({
          ...chatHelper.toStreamTextOptions(),
          model: new MockLanguageModelV3({
            doStream: async () => ({ stream: textStream("just a text reply") }),
          }),
        });
      },
    });

    const res = await withApiContext(() =>
      handler(
        makeRequest({
          chatId: "chat-final",
          trigger: "submit-message",
          // Slim wire: head-start ships full history via `headStartMessages`
          // (not `messages` / `message`). The route handler reads that field
          // off the request body before invoking the customer's run().
          headStartMessages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        })
      )
    );

    // Drain the SSE body so handoverWhenDone observes finishReason.
    const chunks = await readSSEBodyToChunks(res);
    expect(chunks.some((c) => c.type === "text-delta")).toBe(true);

    // Give the deferred handoverWhenDone a tick to dispatch.
    await new Promise((r) => setTimeout(r, 30));

    const handoverPost = requests.find(
      (r) =>
        r.url.includes("/realtime/v1/sessions/chat-final/in/append") &&
        r.init?.body !== undefined
    );
    expect(handoverPost).toBeDefined();
    const body = JSON.parse(handoverPost!.init!.body as string);
    // Pure-text finishes go through `kind: "handover"` with `isFinal: true`
    // so the agent runs hooks (persistence, etc.) without making an LLM call.
    expect(body.kind).toBe("handover");
    expect(body.isFinal).toBe(true);
    // The partial carries the customer's response messages — a single
    // assistant message with the streamed text.
    expect(Array.isArray(body.partialAssistantMessage)).toBe(true);
    const assistant = body.partialAssistantMessage.find(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(assistant).toBeDefined();
  });

  it("dispatches handover with response.messages on tool-call finishReason", async () => {
    const requests: CapturedRequest[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      requests.push({ url: urlStr, init });
      if (urlStr.endsWith("/api/v1/sessions") || urlStr.endsWith("/api/v1/sessions/")) {
        return createSessionResponse("chat-tool");
      }
      if (urlStr.includes("/realtime/v1/sessions/") && urlStr.endsWith("/in/append")) {
        return appendOkResponse();
      }
      // Stitched response now subscribes to `.out` after handover to
      // pick up agent-side chunks. Return an empty SSE body that
      // closes immediately — this test validates dispatch only, not
      // the agent-side resume.
      if (/\/realtime\/v1\/sessions\/[^/]+\/out$/.test(urlStr)) {
        return new Response(new ReadableStream({ start(c) { c.close(); } }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    });

    // Schema-only tool — no execute. The mock model emits a tool-call;
    // AI SDK doesn't run it (no execute) and finishes with "tool-calls".
    const { tool } = await import("ai");
    const { z } = await import("zod");
    const weatherTool = tool({
      description: "weather",
      inputSchema: z.object({ city: z.string() }),
    });

    const handler = chat.headStart({
      agentId: "test-agent",
      run: async ({ chat: chatHelper }) => {
        return streamText({
          ...chatHelper.toStreamTextOptions({ tools: { weather: weatherTool } }),
          model: new MockLanguageModelV3({
            doStream: async () => ({ stream: toolCallStream() }),
          }),
        });
      },
    });

    const res = await withApiContext(() =>
      handler(
        makeRequest({
          chatId: "chat-tool",
          trigger: "submit-message",
          headStartMessages: [
            { id: "m1", role: "user", parts: [{ type: "text", text: "weather in tokyo?" }] },
          ],
        })
      )
    );

    await readSSEBodyToChunks(res);
    await new Promise((r) => setTimeout(r, 30));

    const handoverPost = requests.find(
      (r) =>
        r.url.includes("/realtime/v1/sessions/chat-tool/in/append") &&
        r.init?.body !== undefined
    );
    expect(handoverPost).toBeDefined();
    const body = JSON.parse(handoverPost!.init!.body as string);
    expect(body.kind).toBe("handover");
    expect(body.isFinal).toBe(false); // pending tool-calls — agent runs streamText
    expect(Array.isArray(body.partialAssistantMessage)).toBe(true);

    // The partial is reshaped into AI SDK's tool-approval round so the
    // agent's `streamText` can resume by executing the pending tool-call
    // before step 2. Assistant gets a `tool-approval-request` part
    // alongside the original `tool-call`; a trailing `tool` message
    // carries the `tool-approval-response { approved: true }`.
    const assistant = body.partialAssistantMessage.find(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(assistant).toBeDefined();
    const toolCallPart = assistant.content.find(
      (p: { type: string }) => p.type === "tool-call"
    );
    expect(toolCallPart).toBeDefined();
    const approvalRequestPart = assistant.content.find(
      (p: { type: string }) => p.type === "tool-approval-request"
    );
    expect(approvalRequestPart).toBeDefined();
    expect(approvalRequestPart.toolCallId).toBe(toolCallPart.toolCallId);

    const trailingTool = body.partialAssistantMessage[body.partialAssistantMessage.length - 1];
    expect(trailingTool.role).toBe("tool");
    const approvalResponsePart = trailingTool.content.find(
      (p: { type: string }) => p.type === "tool-approval-response"
    );
    expect(approvalResponsePart).toBeDefined();
    expect(approvalResponsePart.approvalId).toBe(approvalRequestPart.approvalId);
    expect(approvalResponsePart.approved).toBe(true);
  });

  it("rejects requests missing chatId", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));

    const handler = chat.headStart({
      agentId: "test-agent",
      run: async ({ chat: chatHelper }) => {
        return streamText({
          ...chatHelper.toStreamTextOptions(),
          model: new MockLanguageModelV3({
            doStream: async () => ({ stream: textStream("x") }),
          }),
        });
      },
    });

    await expect(
      withApiContext(() =>
        handler(
          makeRequest({
            // no chatId
            trigger: "submit-message",
            messages: [],
          })
        )
      )
    ).rejects.toThrow(/chatId/);
  });
});

describe("chat.toNodeListener", () => {
  /**
   * Build a fake Node IncomingMessage that yields a JSON body.
   * AsyncIterable so the listener can `for await` over it.
   */
  function fakeNodeRequest(opts: {
    method?: string;
    url?: string;
    host?: string;
    headers?: Record<string, string | string[]>;
    body?: string;
  }) {
    const bodyBytes = opts.body ? new TextEncoder().encode(opts.body) : undefined;
    const headers = {
      host: opts.host ?? "example.com",
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    };
    const errorListeners: Array<(e: Error) => void> = [];
    return {
      method: opts.method ?? "POST",
      url: opts.url ?? "/api/chat",
      headers,
      on(event: string, listener: (e: Error) => void) {
        if (event === "error") errorListeners.push(listener);
        return this;
      },
      async *[Symbol.asyncIterator]() {
        if (bodyBytes) yield bodyBytes;
      },
    };
  }

  function fakeNodeResponse() {
    const writes: Uint8Array[] = [];
    let ended = false;
    let endChunk: Uint8Array | string | undefined;
    const closeListeners: Array<() => void> = [];
    const headers: Record<string, string | number | readonly string[]> = {};
    const obj = {
      statusCode: 200,
      headersSent: false,
      setHeader(name: string, value: string | number | readonly string[]) {
        headers[name.toLowerCase()] = value;
      },
      write(chunk: Uint8Array | string) {
        if (typeof chunk === "string") {
          writes.push(new TextEncoder().encode(chunk));
        } else {
          writes.push(chunk);
        }
        obj.headersSent = true;
        return true;
      },
      end(chunk?: Uint8Array | string) {
        ended = true;
        endChunk = chunk;
      },
      on(event: string, listener: () => void) {
        if (event === "close") closeListeners.push(listener);
        return obj;
      },
      // test helpers
      _written() {
        const all = [...writes];
        if (typeof endChunk === "string") all.push(new TextEncoder().encode(endChunk));
        else if (endChunk) all.push(endChunk);
        let total = 0;
        for (const c of all) total += c.length;
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const c of all) {
          merged.set(c, offset);
          offset += c.length;
        }
        return new TextDecoder().decode(merged);
      },
      _ended: () => ended,
      _headers: () => headers,
      _close: () => {
        for (const l of closeListeners) l();
      },
    };
    return obj;
  }

  it("converts the Node request into a Web Request, calls the handler, and forwards the response", async () => {
    const seen: { method?: string; url?: string; ct?: string | null; body?: string } = {};

    const webHandler = async (req: Request): Promise<Response> => {
      seen.method = req.method;
      seen.url = req.url;
      seen.ct = req.headers.get("content-type");
      seen.body = await req.text();
      return new Response("ok", {
        status: 201,
        headers: { "x-test": "1", "content-type": "text/plain" },
      });
    };

    const listener = chat.toNodeListener(webHandler);
    const req = fakeNodeRequest({ body: '{"hello":"world"}' });
    const res = fakeNodeResponse();

    await listener(req as any, res as any);

    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("http://example.com/api/chat");
    expect(seen.ct).toBe("application/json");
    expect(seen.body).toBe('{"hello":"world"}');

    expect(res.statusCode).toBe(201);
    expect(res._headers()["x-test"]).toBe("1");
    expect(res._written()).toBe("ok");
    expect(res._ended()).toBe(true);
  });

  it("streams the Web Response body to the Node response chunk by chunk (no buffering)", async () => {
    const chunkOrder: string[] = [];
    const webHandler = async (): Promise<Response> => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const piece of ["one\n", "two\n", "three\n"]) {
            chunkOrder.push("emit-" + piece.trim());
            controller.enqueue(encoder.encode(piece));
            await new Promise((r) => setTimeout(r, 5));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const listener = chat.toNodeListener(webHandler);
    const req = fakeNodeRequest({});
    const res = fakeNodeResponse();
    await listener(req as any, res as any);

    expect(res._written()).toBe("one\ntwo\nthree\n");
    expect(chunkOrder).toEqual(["emit-one", "emit-two", "emit-three"]);
    expect(res._headers()["content-type"]).toBe("text/event-stream");
  });

  it("propagates client disconnect to the Web handler via AbortSignal", async () => {
    let signal: AbortSignal | undefined;
    let aborted = false;

    const webHandler = async (req: Request): Promise<Response> => {
      signal = req.signal;
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      // Return a never-ending stream so the listener stays open until close.
      return new Response(
        new ReadableStream({
          start() {
            // never enqueues
          },
        })
      );
    };

    const listener = chat.toNodeListener(webHandler);
    const req = fakeNodeRequest({});
    const res = fakeNodeResponse();

    // Run listener in background (it'll hang on the never-ending stream).
    const pending = listener(req as any, res as any);

    // Wait a tick for the handler to attach the abort listener.
    await new Promise((r) => setTimeout(r, 5));

    res._close();
    expect(aborted).toBe(true);

    // Cleanup: the listener will throw (abort) and we don't care about the result.
    await pending.catch(() => {});
  });

  it("returns 500 with error text if the handler throws before headers are sent", async () => {
    const webHandler = async (): Promise<Response> => {
      throw new Error("boom");
    };

    const listener = chat.toNodeListener(webHandler);
    const req = fakeNodeRequest({});
    const res = fakeNodeResponse();
    await listener(req as any, res as any);

    expect(res.statusCode).toBe(500);
    expect(res._written()).toBe("boom");
  });
});
