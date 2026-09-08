import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClientManager } from "@trigger.dev/core/v3";
import type { CreateSessionRequestBody, CreatedSessionResponseBody } from "@trigger.dev/core/v3";
import type { UIMessageChunk } from "ai";

import { AgentChat } from "./chat-client.js";
import { waitBeforeEofResubscribe } from "./ai-shared.js";
import { __setSessionStartImplForTests } from "./sessions.js";

// ── Helpers ────────────────────────────────────────────────────────────

const SESSION_PAT = "pat_test";

function createSessionResponse(externalId: string): Response {
  return new Response(
    JSON.stringify({
      id: "session_test",
      externalId,
      type: "chat.agent",
      taskIdentifier: "test-agent",
      triggerConfig: { basePayload: { chatId: externalId } },
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
      isCached: true,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function appendOkResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function withApiContext<T>(fn: () => Promise<T>): Promise<T> {
  return apiClientManager.runWithConfig(
    { baseURL: "https://api.test.trigger.dev", secretKey: "tr_test_secret" },
    fn
  );
}

/**
 * Records the `triggerConfig` of every `POST /api/v1/sessions`, which is the
 * only request that writes a session's deployment pin.
 */
function stubFetchCapturingSessionStarts(): Array<Record<string, unknown> | undefined> {
  const starts: Array<Record<string, unknown> | undefined> = [];
  global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (/\/api\/v1\/sessions\/?$/.test(urlStr)) {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      starts.push(body.triggerConfig as Record<string, unknown> | undefined);
      return createSessionResponse(String(body.externalId ?? "chat-1"));
    }
    if (urlStr.includes("/realtime/v1/sessions/") && urlStr.endsWith("/in/append")) {
      return appendOkResponse();
    }
    if (urlStr.includes("/realtime/v1/sessions/") && urlStr.endsWith("/out")) {
      return sseResponse(sseBatch([{ seq: 1, turnComplete: true }]));
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  }) as never;
  return starts;
}

/**
 * Encode records as one session-stream v2 batch event. `turnComplete` records
 * take the production header form (empty body, `trigger-control` header).
 */
function sseBatch(
  records: Array<{ seq: number; chunk?: unknown; turnComplete?: boolean; control?: string }>
): string {
  const encoded = records.map((record) =>
    record.turnComplete || record.control
      ? {
          body: "",
          seq_num: record.seq,
          timestamp: 1700000000000 + record.seq,
          headers: [["trigger-control", record.control ?? "turn-complete"]],
        }
      : {
          body: JSON.stringify({ data: record.chunk, id: `p-${record.seq}` }),
          seq_num: record.seq,
          timestamp: 1700000000000 + record.seq,
          headers: [],
        }
  );
  return `event: batch\ndata: ${JSON.stringify({ records: encoded })}\n\n`;
}

/** An SSE body that delivers `sseText` (if any) and then ends — a window EOF. */
function sseResponse(sseText: string, extraHeaders: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (sseText) controller.enqueue(new TextEncoder().encode(sseText));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "X-Stream-Version": "v2",
      ...extraHeaders,
    },
  });
}

/** An SSE body that waits for `ready` before delivering `sseText`, then ends. */
function deferredSseResponse(ready: Promise<void>, sseText: string): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      await ready;
      controller.enqueue(new TextEncoder().encode(sseText));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "X-Stream-Version": "v2" },
  });
}

/**
 * An SSE body that delivers `sseText` and then holds the window open until the
 * request is aborted — a turn still streaming when the caller stops it.
 */
function heldOpenSseResponse(sseText: string, signal?: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseText));
      const onAbort = () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "X-Stream-Version": "v2" },
  });
}

type OutCall = { lastEventId: string | null };

/**
 * Like {@link stubFetchCapturingSessionStarts}, but serves `.out` from a queue
 * of responses (last one repeats) and records every subscription attempt.
 */
function stubFetchWithOutResponses(responses: Array<(init?: RequestInit) => Response>): OutCall[] {
  const outCalls: OutCall[] = [];
  global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (/\/api\/v1\/sessions\/?$/.test(urlStr)) {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      return createSessionResponse(String(body.externalId ?? "chat-1"));
    }
    if (urlStr.includes("/realtime/v1/sessions/") && urlStr.endsWith("/append")) {
      return appendOkResponse();
    }
    if (urlStr.includes("/realtime/v1/sessions/") && urlStr.endsWith("/out")) {
      outCalls.push({ lastEventId: new Headers(init?.headers).get("Last-Event-ID") });
      const next = responses[Math.min(outCalls.length - 1, responses.length - 1)]!;
      return next(init);
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  }) as never;
  return outCalls;
}

async function drain(
  stream: ReadableStream<UIMessageChunk>,
  onChunk?: (chunk: UIMessageChunk) => void
): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      onChunk?.(value);
    }
  } finally {
    reader.releaseLock();
  }
  return chunks;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("AgentChat session restoration", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("refreshes a restored session's deployment pin", async () => {
    // A conversation loaded from the caller's own store is already started, by
    // an earlier request, under whatever deployment THAT release resolved.
    // Only `sessions.start` rewrites the stored config, so skipping it here is
    // what left a persisted conversation pinned to the release it began on for
    // the rest of its life — long after the app had moved on.
    const starts = stubFetchCapturingSessionStarts();

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-restored",
        session: { lastEventId: "42" },
        triggerConfig: { basePayload: {}, externalDeploymentId: "release-new" },
      });

      await chat.sendRaw([{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }]);

      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({ externalDeploymentId: "release-new" });
      // The persisted cursor is what makes it a restore rather than a new chat.
      expect(chat.session.lastEventId).toBe("42");
    });
  });

  it("refreshes the pin once per instance, not once per message", async () => {
    const starts = stubFetchCapturingSessionStarts();

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-restored-twice",
        session: { lastEventId: "7" },
        triggerConfig: { basePayload: {}, externalDeploymentId: "release-new" },
      });

      await chat.sendRaw([{ id: "u1", role: "user", parts: [{ type: "text", text: "one" }] }]);
      await chat.sendRaw([{ id: "u2", role: "user", parts: [{ type: "text", text: "two" }] }]);

      expect(starts).toHaveLength(1);
    });
  });

  it("does not fire onTriggered when a restored session refreshes", async () => {
    // Documented as the initial start. A caller whose hook writes a row would
    // otherwise write it again on every request that rehydrates the chat.
    stubFetchCapturingSessionStarts();
    const triggered: string[] = [];

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-restored-hook",
        session: { lastEventId: "9" },
        onTriggered: ({ runId }) => {
          triggered.push(runId);
        },
      });

      await chat.sendRaw([{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }]);

      expect(triggered).toEqual([]);
    });
  });

  it("still fires onTriggered for a chat that was never started", async () => {
    stubFetchCapturingSessionStarts();
    const triggered: string[] = [];

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-fresh",
        onTriggered: ({ runId }) => {
          triggered.push(runId);
        },
      });

      await chat.sendRaw([{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }]);

      expect(triggered).toEqual(["run_test"]);
    });
  });
});

describe("AgentChat mid-turn EOF", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function sendAndSubscribe(id: string): Promise<ReadableStream<UIMessageChunk>> {
    const chat = new AgentChat({ agent: "test-agent", id });
    return chat.sendRaw([{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }]);
  }

  it("resubscribes from the last event id and delivers the rest of the turn", async () => {
    const outCalls = stubFetchWithOutResponses([
      () =>
        sseResponse(
          sseBatch([
            { seq: 1, chunk: { type: "text-start", id: "part-1" } },
            { seq: 2, chunk: { type: "text-delta", id: "part-1", delta: "Hel" } },
          ])
        ),
      () =>
        sseResponse(
          sseBatch([
            { seq: 3, chunk: { type: "text-delta", id: "part-1", delta: "lo" } },
            { seq: 4, chunk: { type: "text-end", id: "part-1" } },
            { seq: 5, turnComplete: true },
          ])
        ),
    ]);

    await withApiContext(async () => {
      const chunks = await drain(await sendAndSubscribe("chat-eof-resume"));

      expect(chunks.map((c) => c.type)).toEqual([
        "text-start",
        "text-delta",
        "text-delta",
        "text-end",
      ]);
      expect(outCalls).toHaveLength(2);
      expect(outCalls[1]?.lastEventId).toBe("2");
    });
  });

  it("resumes a sendAction turn across a mid-turn EOF", async () => {
    const outCalls = stubFetchWithOutResponses([
      () => sseResponse(sseBatch([{ seq: 1, chunk: { type: "text-start", id: "part-1" } }])),
      () =>
        sseResponse(
          sseBatch([
            { seq: 2, chunk: { type: "text-end", id: "part-1" } },
            { seq: 3, turnComplete: true },
          ])
        ),
    ]);

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-eof-action" });
      const stream = await chat.sendAction({ type: "undo" });
      const chunks: UIMessageChunk[] = [];
      for await (const chunk of stream) chunks.push(chunk);

      expect(chunks.map((c) => c.type)).toEqual(["text-start", "text-end"]);
      expect(outCalls).toHaveLength(2);
      expect(outCalls[1]?.lastEventId).toBe("1");
    });
  });

  it("keeps streaming a turn that spans more windows than the budget", async () => {
    // A clean EOF ends every long-poll window, so a long turn must re-earn the
    // budget on each record instead of erroring after MAX_EOF_RESUBSCRIBES.
    const windows = 8;
    const responses = Array.from(
      { length: windows },
      (_unused, index) => () =>
        sseResponse(
          sseBatch([
            { seq: index + 1, chunk: { type: "text-delta", id: "part-1", delta: String(index) } },
            ...(index === windows - 1 ? [{ seq: windows + 1, turnComplete: true }] : []),
          ])
        )
    );
    const outCalls = stubFetchWithOutResponses(responses);

    await withApiContext(async () => {
      const chunks = await drain(await sendAndSubscribe("chat-eof-long-turn"));

      expect(chunks).toHaveLength(windows);
      expect(outCalls).toHaveLength(windows);
    });
  });

  it("delivers a follow-up turn after an aborted one left the gate armed", async () => {
    // The aborted stream never sees the stopped turn's boundary, so the NEXT
    // stream reads it as stale history: it must clear the gate and keep reading
    // to its own turn instead of ending there.
    const outCalls = stubFetchWithOutResponses([
      (init) =>
        heldOpenSseResponse(
          sseBatch([{ seq: 1, chunk: { type: "text-delta", id: "part-1", delta: "half" } }]),
          init?.signal
        ),
      () =>
        sseResponse(
          sseBatch([
            // The stopped turn's boundary, then the follow-up turn.
            { seq: 2, turnComplete: true },
            { seq: 3, chunk: { type: "text-start", id: "part-2" } },
            { seq: 4, chunk: { type: "text-end", id: "part-2" } },
            { seq: 5, turnComplete: true },
          ])
        ),
    ]);

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-stop-then-send" });
      const abort = new AbortController();
      const first = await chat.sendRaw(
        [{ id: "u1", role: "user", parts: [{ type: "text", text: "one" }] }],
        { abortSignal: abort.signal }
      );

      const firstChunks = await drain(first, () => abort.abort());
      expect(firstChunks).toHaveLength(1);

      const second = await chat.sendRaw([
        { id: "u2", role: "user", parts: [{ type: "text", text: "two" }] },
      ]);
      const secondChunks = await drain(second);

      expect(secondChunks.map((c) => c.type)).toEqual(["text-start", "text-end"]);
      // One window per stream, and the second one resumed past the first turn.
      expect(outCalls).toHaveLength(2);
    });
  });

  describe("stop() with a follow-up turn already subscribed", () => {
    // `stop()` does not abort its subscription, so both streams are live and
    // both read the stopped turn's boundary. Whichever gets there first must
    // not decide for the other.
    function stubBothStreams() {
      let releaseStopped: () => void = () => {};
      let releaseFollowUp: () => void = () => {};
      const stopped = new Promise<void>((resolve) => {
        releaseStopped = resolve;
      });
      const followUp = new Promise<void>((resolve) => {
        releaseFollowUp = resolve;
      });
      const outCalls = stubFetchWithOutResponses([
        () => deferredSseResponse(stopped, sseBatch([{ seq: 2, turnComplete: true }])),
        () =>
          deferredSseResponse(
            followUp,
            sseBatch([
              // The stopped turn's boundary replayed, then this turn.
              { seq: 2, turnComplete: true },
              { seq: 3, chunk: { type: "text-start", id: "part-2" } },
              { seq: 4, chunk: { type: "text-end", id: "part-2" } },
              { seq: 5, turnComplete: true },
            ])
          ),
      ]);
      return {
        outCalls,
        releaseStopped: () => releaseStopped(),
        releaseFollowUp: () => releaseFollowUp(),
      };
    }

    async function stopThenSend(id: string, turnCompletes: string[] = []) {
      const chat = new AgentChat({
        agent: "test-agent",
        id,
        onTurnComplete: ({ lastEventId }) => {
          turnCompletes.push(lastEventId ?? "");
        },
      });
      const stopped = await chat.sendRaw([
        { id: "u1", role: "user", parts: [{ type: "text", text: "one" }] },
      ]);
      await chat.stop();
      const followUp = await chat.sendRaw([
        { id: "u2", role: "user", parts: [{ type: "text", text: "two" }] },
      ]);
      return { stopped, followUp };
    }

    it("delivers the follow-up turn when the stopped stream reads the boundary first", async () => {
      const streams = stubBothStreams();

      const turnCompletes: string[] = [];

      await withApiContext(async () => {
        const { stopped, followUp } = await stopThenSend("chat-stop-race-a", turnCompletes);

        streams.releaseStopped();
        expect(await drain(stopped)).toHaveLength(0);

        streams.releaseFollowUp();
        const chunks = await drain(followUp);

        expect(chunks.map((c) => c.type)).toEqual(["text-start", "text-end"]);
        expect(streams.outCalls).toHaveLength(2);
        // Only the follow-up's own boundary completes a turn; the stopped
        // stream ends at a boundary that was never its turn's completion.
        expect(turnCompletes).toEqual(["5"]);
      });
    });

    it("delivers the follow-up turn when it reads the boundary first", async () => {
      const streams = stubBothStreams();

      const turnCompletes: string[] = [];

      await withApiContext(async () => {
        const { stopped, followUp } = await stopThenSend("chat-stop-race-b", turnCompletes);

        streams.releaseFollowUp();
        const chunks = await drain(followUp);

        expect(chunks.map((c) => c.type)).toEqual(["text-start", "text-end"]);

        streams.releaseStopped();
        expect(await drain(stopped)).toHaveLength(0);
        expect(streams.outCalls).toHaveLength(2);
        expect(turnCompletes).toEqual(["5"]);
      });
    });
  });

  it("ends the stream when the stop gate consumes the turn boundary", async () => {
    // `stop()` arms the gate, so the stopped turn's own turn-complete is
    // swallowed by it and never reaches the terminal branch. The turn is over
    // all the same: the EOF behind it must not start the resume loop.
    let release: () => void = () => {};
    const armed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outCalls = stubFetchWithOutResponses([
      () =>
        deferredSseResponse(
          armed,
          sseBatch([
            { seq: 1, chunk: { type: "text-delta", id: "part-1", delta: "half" } },
            { seq: 2, turnComplete: true },
          ])
        ),
    ]);

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-stop-gate" });
      const stream = await chat.sendRaw([
        { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ]);

      await chat.stop();
      release();

      const chunks = await drain(stream);

      expect(chunks).toHaveLength(0);
      expect(outCalls).toHaveLength(1);
    });
  });

  it("does not resubscribe when the server says the session settled", async () => {
    const outCalls = stubFetchWithOutResponses([
      () =>
        sseResponse(sseBatch([{ seq: 1, chunk: { type: "text-start", id: "part-1" } }]), {
          "X-Session-Settled": "true",
        }),
    ]);

    await withApiContext(async () => {
      const chunks = await drain(await sendAndSubscribe("chat-eof-settled"));

      expect(chunks).toHaveLength(1);
      expect(outCalls).toHaveLength(1);
    });
  });

  it("errors the stream once the resubscribe budget is exhausted", async () => {
    const outCalls = stubFetchWithOutResponses([() => sseResponse("")]);

    await withApiContext(async () => {
      await expect(drain(await sendAndSubscribe("chat-eof-budget"))).rejects.toThrow(
        /reconnect budget exhausted/
      );
      // The initial subscription plus MAX_EOF_RESUBSCRIBES retries.
      expect(outCalls).toHaveLength(6);
    });
  });

  it("stops promptly when aborted during the backoff", async () => {
    const outCalls = stubFetchWithOutResponses([
      () => sseResponse(sseBatch([{ seq: 1, chunk: { type: "text-start", id: "part-1" } }])),
    ]);

    await withApiContext(async () => {
      const abort = new AbortController();
      const chat = new AgentChat({ agent: "test-agent", id: "chat-eof-abort" });
      const stream = await chat.sendRaw(
        [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        { abortSignal: abort.signal }
      );

      // Abort on a timer, not on the chunk: the EOF right behind it is already
      // processed by then, so the abort lands inside the backoff timer (>= 50ms)
      // rather than on the pre-backoff aborted check.
      const chunks = await drain(stream, () => setTimeout(() => abort.abort(), 20));

      expect(chunks).toHaveLength(1);
      expect(outCalls).toHaveLength(1);
    });
  });

  it("does not wait when the signal is already aborted", async () => {
    const started = Date.now();

    await waitBeforeEofResubscribe(6, AbortSignal.abort());

    expect(Date.now() - started).toBeLessThan(10);
  });

  it("wakes the backoff immediately on abort", async () => {
    // Attempt 6 sits on the 5s cap, so a backoff that ran to completion could
    // not resolve this fast.
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => abort.abort(), 20);

    await waitBeforeEofResubscribe(6, abort.signal);

    expect(Date.now() - started).toBeLessThan(500);
  });

  it("resumes a reconnected turn once records have flowed", async () => {
    // Records on the wire are the discriminator `peekSettled` can't give us:
    // a window that delivered chunks was a live turn, so its EOF is a lost
    // window rather than the end of the conversation.
    const outCalls = stubFetchWithOutResponses([
      () => sseResponse(sseBatch([{ seq: 1, chunk: { type: "text-start", id: "part-1" } }])),
      () =>
        sseResponse(
          sseBatch([
            { seq: 2, chunk: { type: "text-end", id: "part-1" } },
            { seq: 3, turnComplete: true },
          ])
        ),
    ]);

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-eof-reconnect-live",
        session: { lastEventId: "0" },
      });

      const chunks = await drain((await chat.reconnect())!);

      expect(chunks.map((c) => c.type)).toEqual(["text-start", "text-end"]);
      expect(outCalls).toHaveLength(2);
      expect(outCalls[1]?.lastEventId).toBe("1");
    });
  });

  it("resumes a reconnected stream across a version handover", async () => {
    // A pending-version marker is the handover status of a turn that carries on
    // in a successor run — its chunks only arrive in a later window.
    const outCalls = stubFetchWithOutResponses([
      () => sseResponse(sseBatch([{ seq: 1, control: "pending-version" }])),
      () =>
        sseResponse(
          sseBatch([
            { seq: 2, chunk: { type: "text-start", id: "part-1" } },
            { seq: 3, chunk: { type: "text-end", id: "part-1" } },
            { seq: 4, turnComplete: true },
          ])
        ),
    ]);

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-eof-handover",
        session: { lastEventId: "0" },
      });

      const chunks = await drain((await chat.reconnect())!);

      expect(chunks.map((c) => c.type)).toEqual(["text-start", "text-end"]);
      expect(outCalls).toHaveLength(2);
      expect(outCalls[1]?.lastEventId).toBe("1");
    });
  });

  it("closes cleanly when reconnecting onto a session-closed record", async () => {
    // The agent writes session-closed AFTER turn-complete, so only a reconnect
    // reads it — and the settle peek only sees the last two records, so this
    // window can arrive unsettled. The conversation is over either way.
    const outCalls = stubFetchWithOutResponses([
      () => sseResponse(sseBatch([{ seq: 9, control: "session-closed" }])),
    ]);

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-session-closed",
        session: { lastEventId: "8" },
      });

      const chunks = await drain((await chat.reconnect())!);

      expect(chunks).toHaveLength(0);
      expect(outCalls).toHaveLength(1);
    });
  });

  it("closes a send-path stream on a session-closed record", async () => {
    const outCalls = stubFetchWithOutResponses([
      () =>
        sseResponse(
          sseBatch([
            { seq: 1, chunk: { type: "text-start", id: "part-1" } },
            { seq: 2, control: "session-closed" },
          ])
        ),
    ]);

    await withApiContext(async () => {
      const chunks = await drain(await sendAndSubscribe("chat-send-closed"));

      expect(chunks).toHaveLength(1);
      expect(outCalls).toHaveLength(1);
    });
  });

  it("closes after one empty window when reconnecting, without resubscribing", async () => {
    // A window that delivered nothing on the reconnect path is an idle or dead
    // session as often as a dropped turn, so it must not long-poll again.
    const outCalls = stubFetchWithOutResponses([() => sseResponse("")]);

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-eof-reconnect",
        session: { lastEventId: "0" },
      });

      const stream = await chat.reconnect();
      const chunks = await drain(stream!);

      expect(chunks).toHaveLength(0);
      expect(outCalls).toHaveLength(1);
    });
  });
});

describe("AgentChat", () => {
  afterEach(() => {
    __setSessionStartImplForTests(undefined);
  });

  it("forwards the configured ttl when starting a session", async () => {
    let capturedBody: CreateSessionRequestBody | undefined;
    __setSessionStartImplForTests((body) => {
      capturedBody = body;
      const result: CreatedSessionResponseBody = {
        id: "session_1",
        externalId: body.externalId ?? null,
        type: body.type,
        taskIdentifier: body.taskIdentifier,
        triggerConfig: body.triggerConfig,
        currentRunId: "run_1",
        tags: body.tags ?? [],
        metadata: null,
        closedAt: null,
        closedReason: null,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        runId: "run_1",
        publicAccessToken: "pat_test",
        isCached: false,
      };
      return result;
    });

    const chat = new AgentChat({
      agent: "my-agent",
      id: "chat_1",
      triggerConfig: { basePayload: {}, ttl: "1h" },
    });

    await chat.preload();

    expect(capturedBody?.triggerConfig.ttl).toBe("1h");
  });
});
