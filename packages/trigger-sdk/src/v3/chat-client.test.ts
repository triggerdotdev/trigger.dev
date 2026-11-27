import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClientManager } from "@trigger.dev/core/v3";
import type { CreateSessionRequestBody, CreatedSessionResponseBody } from "@trigger.dev/core/v3";
import type { UIMessageChunk } from "ai";

import { AgentChat } from "./chat-client.js";
import { waitBeforeEofResubscribe } from "./ai-shared.js";
import { __setSessionStartImplForTests } from "./sessions.js";

// ── Helpers ────────────────────────────────────────────────────────────

const SESSION_PAT = "pat_test";

function createSessionResponse(externalId: string, isCached = true): Response {
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
      isCached,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function appendOkResponse(seq?: number): Response {
  return new Response(JSON.stringify({ ok: true, ...(seq !== undefined ? { seq } : {}) }), {
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
  records: Array<{
    seq: number;
    chunk?: unknown;
    turnComplete?: boolean;
    control?: string;
    /** The boundary's committed `.in` cursor (`session-in-event-id` header). */
    inCursor?: number;
    /** A `turn-start` marker's `.in` seq (`turn-start-in-seq` header; a list for a `turn-join`). */
    startOf?: number | string;
    /** A `turn-join` marker's injection chunk id (`turn-join-injection-id` header). */
    injectionId?: string;
  }>
): string {
  const encoded = records.map((record) =>
    record.turnComplete || record.control
      ? {
          body: "",
          seq_num: record.seq,
          timestamp: 1700000000000 + record.seq,
          headers: [
            ["trigger-control", record.control ?? "turn-complete"],
            ...(record.inCursor !== undefined
              ? [["session-in-event-id", String(record.inCursor)]]
              : []),
            ...(record.startOf !== undefined
              ? [["turn-start-in-seq", String(record.startOf)]]
              : []),
            ...(record.injectionId !== undefined
              ? [["turn-join-injection-id", record.injectionId]]
              : []),
          ],
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

// ── Cursorless `.out` reads ────────────────────────────────────────────

type RecordsMode = "headers" | "no-headers" | "fail" | "unavailable" | "malformed";

type LogRecord = {
  seq: number;
  chunk?: unknown;
  boundary?: boolean;
  inCursor?: number;
  /** A `turn-start` marker, naming the `.in` seq it answers (none for a turn with no message). */
  marker?: { inSeq?: number };
  /** A `turn-join` marker: the `.in` seqs folded into the running turn, and the injection chunk it points at. */
  join?: { inSeqs: number[]; injectionId?: string };
};

/** The records of one answered turn: a text part, then the turn's boundary. */
function answerRecords(
  firstSeq: number,
  text: string,
  inCursor: number,
  options?: { marked?: boolean }
): LogRecord[] {
  // A newer agent marks where the turn starts, one record ahead of it.
  if (options?.marked) {
    return [
      { seq: firstSeq, marker: { inSeq: inCursor } },
      ...answerRecords(firstSeq + 1, text, inCursor),
    ];
  }
  return [
    { seq: firstSeq, chunk: { type: "text-start", id: `t-${inCursor}` } },
    { seq: firstSeq + 1, chunk: { type: "text-delta", id: `t-${inCursor}`, delta: text } },
    { seq: firstSeq + 2, chunk: { type: "text-end", id: `t-${inCursor}` } },
    { seq: firstSeq + 3, boundary: true, inCursor },
  ];
}

/** Waits for `wait`, and rejects with an `AbortError` as soon as `signal` aborts. */
function abortable(wait: Promise<void> | undefined, signal: AbortSignal | undefined) {
  if (!wait) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    wait.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}

/**
 * A session that keeps `.in` and `.out` the way the server does: every append
 * gets the next `.in` seq, `onAppend` plays the agent answering it onto
 * `.out`, and a read serves the records after its `Last-Event-ID` (all of the
 * retained window when it sends none), at most `windowSize` per response.
 */
function stubSession(options: {
  retained?: LogRecord[];
  inSeq?: number;
  windowSize?: number;
  /**
   * What `GET .../out/records` (the `wait=0` drain) does: serve records with
   * their headers, serve them without (a server that predates headers), or fail.
   */
  records?: RecordsMode;
  /** `.out` responses wait for this before they are served. */
  outGate?: Promise<void>;
  /** `.out/records` responses wait for this before they are built from the log. */
  recordsGate?: Promise<void>;
  /** Each `.out/records` response takes this long (a timer, so fake timers drive it). */
  recordsDelayMs?: number;
  onAppend: (inSeq: number, log: LogRecord[], body: string) => void;
}) {
  const log: LogRecord[] = [...(options.retained ?? [])];
  let inSeq = options.inSeq ?? 0;
  let recordsMode = options.records;
  const outCalls: OutCall[] = [];
  const recordsCalls: Array<string | null> = [];
  global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (/\/api\/v1\/sessions\/?$/.test(urlStr)) {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      return createSessionResponse(String(body.externalId ?? "chat-1"));
    }
    if (urlStr.includes("/out/records")) {
      const afterEventId = new URL(urlStr).searchParams.get("afterEventId");
      recordsCalls.push(afterEventId);
      // A real `fetch` rejects when its signal aborts; so does the stub.
      const signal = init?.signal ?? undefined;
      await abortable(options.recordsGate, signal);
      if (options.recordsDelayMs) {
        await abortable(new Promise<void>((r) => setTimeout(r, options.recordsDelayMs)), signal);
      }
      // A 4xx is not retried by the client, so the fallback is reached at once.
      if (recordsMode === "fail") return new Response("nope", { status: 404 });
      if (recordsMode === "unavailable") return new Response("down", { status: 503 });
      if (recordsMode === "malformed") return Response.json({ records: "x" });
      // The records route takes `afterEventId` as digits only.
      if (afterEventId !== null && !/^\d+$/.test(afterEventId)) {
        return new Response("invalid afterEventId", { status: 400 });
      }
      const after = afterEventId ? Number(afterEventId) : -1;
      const page = log.filter((r) => r.seq > after).slice(0, options.windowSize ?? Infinity);
      return new Response(
        JSON.stringify({
          records: page.map((r) => ({
            data: r.boundary || r.marker || r.join ? "" : r.chunk,
            id: String(r.seq),
            seqNum: r.seq,
            ...(r.marker
              ? {
                  headers: [
                    ["trigger-control", "turn-start"],
                    ...(r.marker.inSeq !== undefined
                      ? [["turn-start-in-seq", String(r.marker.inSeq)]]
                      : []),
                  ],
                }
              : {}),
            ...(r.join
              ? {
                  headers: [
                    ["trigger-control", "turn-join"],
                    ["turn-start-in-seq", r.join.inSeqs.join(",")],
                    ...(r.join.injectionId !== undefined
                      ? [["turn-join-injection-id", r.join.injectionId]]
                      : []),
                  ],
                }
              : {}),
            ...(r.boundary && recordsMode !== "no-headers"
              ? {
                  headers: [
                    ["trigger-control", "turn-complete"],
                    ...(r.inCursor !== undefined
                      ? [["session-in-event-id", String(r.inCursor)]]
                      : []),
                  ],
                }
              : {}),
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (urlStr.endsWith("/in/append")) {
      inSeq += 1;
      options.onAppend(inSeq, log, String(init?.body ?? ""));
      return appendOkResponse(inSeq);
    }
    if (urlStr.endsWith("/out")) {
      await options.outGate;
      const lastEventId = new Headers(init?.headers).get("Last-Event-ID");
      outCalls.push({ lastEventId });
      const after = lastEventId ? Number(lastEventId) : -1;
      const window = log.filter((r) => r.seq > after).slice(0, options.windowSize ?? Infinity);
      return sseResponse(
        window.length
          ? sseBatch(
              window.map((r) =>
                r.marker
                  ? { seq: r.seq, control: "turn-start", startOf: r.marker.inSeq }
                  : r.join
                    ? {
                        seq: r.seq,
                        control: "turn-join",
                        startOf: r.join.inSeqs.join(","),
                        injectionId: r.join.injectionId,
                      }
                    : r.boundary
                      ? { seq: r.seq, turnComplete: true, inCursor: r.inCursor }
                      : { seq: r.seq, chunk: r.chunk }
              )
            )
          : ""
      );
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  }) as never;
  return {
    log,
    outCalls,
    recordsCalls,
    setRecords: (mode: RecordsMode) => {
      recordsMode = mode;
    },
  };
}

describe("AgentChat reading a turn without a cursor", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const earlierTurns = [...answerRecords(1, "done: one", 1), ...answerRecords(5, "done: two", 2)];

  // The agent answers each message as soon as it lands on `.in`.
  const answerEach = (text: string) => (inSeq: number, log: LogRecord[]) => {
    const next = (log.at(-1)?.seq ?? 0) + 1;
    log.push(...answerRecords(next, `${text}${inSeq}`, inSeq));
  };

  // `headers` takes the live path (the drain tells where this turn starts); the
  // others can't, and fall back to holding chunks until a boundary says whose
  // they are.
  for (const records of ["headers", "no-headers", "unavailable"] as const) {
    it(`returns the new turn's answer when the retained window holds earlier turns (${records})`, async () => {
      // Catches: a client created without `session.lastEventId` reading from the
      // start of the retained window and closing on the first turn-complete it
      // meets, returning an earlier turn's reply as the answer to the new message.
      stubSession({ retained: earlierTurns, inSeq: 2, records, onAppend: answerEach("done: ") });
      const completed: Array<string | undefined> = [];

      await withApiContext(async () => {
        const chat = new AgentChat({
          agent: "test-agent",
          id: "chat-cursorless",
          session: {},
          onTurnComplete: ({ lastEventId }) => {
            completed.push(lastEventId);
          },
        });

        const text = await (await chat.sendMessage("three")).text();

        expect(text).toBe("done: 3");
        // The persisted cursor is the new turn's own boundary, not an earlier one.
        expect(completed).toEqual(["12"]);
        expect(chat.session.lastEventId).toBe("12");
      });
    });

    it(`returns each turn's own answer across a restore without a cursor (${records})`, async () => {
      // Catches: the same wrong-turn answer on the continuation path callers use
      // across requests (`new AgentChat({ agent, id })` for an existing chat).
      stubSession({ retained: earlierTurns, inSeq: 2, records, onAppend: answerEach("answer ") });

      await withApiContext(async () => {
        const first = new AgentChat({ agent: "test-agent", id: "chat-restore", session: {} });
        expect(await (await first.sendMessage("three")).text()).toBe("answer 3");

        // A second process: still no cursor, so it replays the window again.
        const second = new AgentChat({ agent: "test-agent", id: "chat-restore", session: {} });
        expect(await (await second.sendMessage("four")).text()).toBe("answer 4");
      });
    });

    it(`keeps earlier turns out when the window ends before the new turn is written (${records})`, async () => {
      // Catches: dropping earlier turns' chunks only within one `.out` response, so
      // a window that ends mid-replay lets the rest of the earlier turns through.
      stubSession({
        retained: earlierTurns,
        inSeq: 2,
        windowSize: 3,
        records,
        onAppend: answerEach("answer "),
      });

      await withApiContext(async () => {
        const chat = new AgentChat({ agent: "test-agent", id: "chat-windows", session: {} });
        expect(await (await chat.sendMessage("three")).text()).toBe("answer 3");
      });
    });
  }

  it("holds the answer when an earlier message is owed and nothing of its turn is on .out yet", async () => {
    // Catches: the shared lookup ending its hold at a quiet tail whose last
    // boundary's cursor is below the send's predecessor (message 2 is owed and about
    // to answer), so message 2's reply was returned as the send's: "answer 2answer 3".
    stubSession({
      retained: answerRecords(1, "answer 1", 1),
      inSeq: 2,
      onAppend: (inSeq, log) => {
        // The agent starts message 2's turn only after the lookup has read `.out`.
        setTimeout(() => {
          log.push(...answerRecords((log.at(-1)?.seq ?? 0) + 1, "answer 2", 2));
          log.push(...answerRecords((log.at(-1)?.seq ?? 0) + 1, `answer ${inSeq}`, inSeq));
        }, 50);
      },
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-owed", session: {} });

      expect(await (await chat.sendMessage("three")).text()).toBe("answer 3");
    });
  });

  it("starts before a recovered turn's marker when its boundary cursor is still behind", async () => {
    // Catches: the shared lookup skipping a turn the agent marked as the send's own
    // (turn-start naming its seq) because its boundary's committed cursor sits below
    // the seq, so the stream started after the turn's output and never saw it.
    stubSession({
      retained: answerRecords(1, "answer 1", 1),
      inSeq: 1,
      onAppend: (_inSeq, log) => {
        // A recovered turn for message 2, written before the lookup reads `.out`:
        // its boundary still carries cursor 1, as the router holds it below owed inputs.
        const next = (log.at(-1)?.seq ?? 0) + 1;
        log.push({ seq: next, marker: { inSeq: 2 } }, ...answerRecords(next + 1, "recovered", 1));
      },
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-recovered", session: {} });
      const text = chat.sendMessage("two").then((r) => r.text());

      expect(
        await Promise.race([text, new Promise((r) => setTimeout(() => r("timed out"), 1_500))])
      ).toBe("recovered");
    });
  });

  it("streams a cursorless send on an existing chat before its boundary is written", async () => {
    // Catches: holding a cursorless turn's chunks until its boundary even though
    // the records drain says where the turn starts, which ends live streaming.
    let releaseBoundary: () => void = () => {};
    const boundaryWritten = new Promise<void>((resolve) => {
      releaseBoundary = resolve;
    });
    const outCursors: Array<string | null> = [];
    global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (/\/api\/v1\/sessions\/?$/.test(urlStr)) return createSessionResponse("chat-live");
      if (urlStr.endsWith("/in/append")) return appendOkResponse(2);
      if (urlStr.includes("/out/records")) {
        // Turn one is complete and nothing of turn two is written yet.
        const drained = new URL(urlStr).searchParams.has("afterEventId");
        return new Response(
          JSON.stringify({
            records: drained
              ? []
              : [
                  { data: { type: "text-delta", id: "a", delta: "old" }, id: "1", seqNum: 1 },
                  {
                    data: "",
                    id: "2",
                    seqNum: 2,
                    headers: [
                      ["trigger-control", "turn-complete"],
                      ["session-in-event-id", "1"],
                    ],
                  },
                ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (urlStr.endsWith("/out")) {
        outCursors.push(new Headers(init?.headers).get("Last-Event-ID"));
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                sseBatch([{ seq: 3, chunk: { type: "text-start", id: "b" } }])
              )
            );
            await boundaryWritten;
            controller.enqueue(
              new TextEncoder().encode(sseBatch([{ seq: 4, turnComplete: true, inCursor: 2 }]))
            );
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "X-Stream-Version": "v2" },
        });
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    }) as never;

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-live", session: {} });
      const reader = (
        await chat.sendRaw([{ id: "u2", role: "user", parts: [{ type: "text", text: "two" }] }])
      ).getReader();

      // The chunk arrives while the turn's boundary has not been written yet.
      expect((await reader.read()).value).toEqual({ type: "text-start", id: "b" });
      // The subscription starts after the earlier turn's boundary, not at the head.
      expect(outCursors).toEqual(["2"]);

      releaseBoundary();
      expect((await reader.read()).done).toBe(true);
    });
  });

  it("resumes a cancelled cursorless turn from the chunks it never delivered", async () => {
    // Catches: the resume cursor advancing past chunks that were held and then
    // dropped with a cancelled stream, so reconnect() returns only the tail of
    // the turn.
    const { log } = stubSession({
      retained: answerRecords(1, "done: one", 1),
      inSeq: 1,
      // The drain is unavailable, so the stream holds chunks until a boundary.
      records: "unavailable",
      onAppend: (_inSeq, l) => {
        l.push(
          { seq: 5, chunk: { type: "text-start", id: "b" } },
          { seq: 6, chunk: { type: "text-delta", id: "b", delta: "mine" } }
        );
      },
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-cancel", session: {} });
      const stream = await chat.sendRaw([
        { id: "u2", role: "user", parts: [{ type: "text", text: "two" }] },
      ]);
      const reader = stream.getReader();
      // Cancel while the turn is still being written; the held chunks are never delivered.
      setTimeout(() => void reader.cancel(), 10);
      await reader.closed.catch(() => {});
      log.push(
        { seq: 7, chunk: { type: "text-end", id: "b" } },
        { seq: 8, boundary: true, inCursor: 2 }
      );

      const resumed = await chat.reconnect();
      const chunks = await drain(resumed!);

      expect(chunks.map((c) => c.type)).toEqual(["text-start", "text-delta", "text-end"]);
    });
  });

  it("reads on after a page until an empty one confirms the tail", async () => {
    // Catches: taking a page shorter than some fixed size as the tail, though the
    // server enforces no page size, so a page cut short by the server leaves the
    // rest unread and the turn's start unfound.
    const { recordsCalls, outCalls } = stubSession({
      retained: earlierTurns,
      inSeq: 2,
      // The server cuts pages at five records, far below any fixed page size.
      windowSize: 5,
      onAppend: answerEach("answer "),
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-short-pages", session: {} });
      expect(await (await chat.sendMessage("three")).text()).toBe("answer 3");
      // Two short, non-empty pages, then the page that holds this turn's boundary.
      expect(recordsCalls).toEqual([null, "5", "10"]);
      // The turn's start was found (the earlier turn's boundary), not held for.
      expect(outCalls[0]?.lastEventId).toBe("8");
    });
  });

  it("stops the turn-start read when the caller aborts, as an aborted send does", async () => {
    // Catches: a drain that ignores the send's abort signal, so a cancelled send
    // waits out the whole read (tens of seconds) before it can stop its turn.
    const appended: string[] = [];
    const session = stubSession({
      retained: earlierTurns,
      inSeq: 2,
      // The drain's response never arrives.
      recordsGate: new Promise<void>(() => {}),
      onAppend: (_inSeq, _log, body) => {
        appended.push(body);
      },
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-abort-drain", session: {} });
      const controller = new AbortController();
      const sending = chat.sendRaw(
        [{ id: "u3", role: "user", parts: [{ type: "text", text: "three" }] }],
        { abortSignal: controller.signal }
      );
      await vi.waitFor(() => expect(session.recordsCalls).toHaveLength(1));

      controller.abort();
      const stream = await Promise.race([
        sending,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("the drain ignored the abort")), 1_000)
        ),
      ]);

      expect(await drain(stream)).toHaveLength(0);
      // Not retried, and the turn the send started is stopped, as any abort does.
      expect(session.recordsCalls).toHaveLength(1);
      expect(appended.filter((body) => body.includes('"kind":"stop"'))).toHaveLength(1);
    });
  });

  it("stops reading for the turn start at an overall deadline and holds", async () => {
    // Catches: a drain bounded only per request, so a window that keeps answering
    // slowly holds the send for pages x attempts x timeout instead of one deadline.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const retained = Array.from({ length: 20 }, (_, i) => ({
        seq: i + 1,
        chunk: { type: "text-delta", id: "a", delta: String(i) },
      }));
      const session = stubSession({
        retained,
        inSeq: 2,
        // One record per page, each page slow but inside the per-request timeout.
        windowSize: 1,
        recordsDelayMs: 1_200,
        onAppend: () => {},
      });

      await withApiContext(async () => {
        const chat = new AgentChat({ agent: "test-agent", id: "chat-deadline", session: {} });
        let settled = false;
        const sending = chat
          .sendRaw([{ id: "u3", role: "user", parts: [{ type: "text", text: "three" }] }])
          .then((stream) => {
            settled = true;
            return stream;
          });

        // Two pages have arrived by 2.4s: still reading.
        await vi.advanceTimersByTimeAsync(2_500);
        expect(settled).toBe(false);
        // Past the 3s deadline the third read is cut off and the send holds.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(settled).toBe(true);
        expect(session.recordsCalls).toHaveLength(3);
        await (await sending).cancel();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back after one quick retry when the drain keeps failing with a 5xx", async () => {
    // Catches: the send waiting out the API client's full retry schedule on a
    // drain that is down, before it falls back to holding.
    const { recordsCalls } = stubSession({
      retained: earlierTurns,
      inSeq: 2,
      records: "unavailable",
      onAppend: answerEach("answer "),
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-5xx", session: {} });
      const started = Date.now();
      expect(await (await chat.sendMessage("three")).text()).toBe("answer 3");
      expect(recordsCalls).toHaveLength(2);
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  it("holds without retrying when the drain answers with a body it can't read", async () => {
    // Catches: a 200 whose body isn't a records list being read as records (or as
    // the tail), or retried like a 5xx, instead of falling back to holding.
    const { recordsCalls } = stubSession({
      retained: earlierTurns,
      inSeq: 2,
      records: "malformed",
      onAppend: answerEach("answer "),
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-malformed", session: {} });
      expect(await (await chat.sendMessage("three")).text()).toBe("answer 3");
      expect(recordsCalls).toHaveLength(1);
    });
  });

  it("holds after a send was aborted before it read a record, so the stop gate still clears", async () => {
    // Catches: locating the turn start past the aborted turn's boundary while the
    // stop gate is still armed, so the gate swallows the next turn's chunks and
    // takes its boundary for the stale one.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = stubSession({
      retained: answerRecords(1, "done: one", 1),
      inSeq: 1,
      // The first send can't find its turn start, so it holds from the head.
      records: "unavailable",
      outGate: gate,
      onAppend: (inSeq, log, body) => {
        if (body.includes('"kind":"stop"')) return;
        // Only the second message is answered; the first is stopped.
        if (inSeq > 2) log.push(...answerRecords(log.at(-1)!.seq + 1, "second", inSeq));
      },
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-aborted", session: {} });
      const controller = new AbortController();
      const stopped = await chat.sendRaw(
        [{ id: "u2", role: "user", parts: [{ type: "text", text: "two" }] }],
        { abortSignal: controller.signal }
      );
      // Aborted before any record was read, then the agent writes the stopped turn's boundary.
      controller.abort();
      release();
      await drain(stopped);
      session.log.push({ seq: 5, boundary: true, inCursor: 2 });

      session.setRecords("headers");
      const chunks = await drain(
        await chat.sendRaw([{ id: "u3", role: "user", parts: [{ type: "text", text: "three" }] }])
      );

      expect(chunks.map((c) => (c as { delta?: string }).delta).filter(Boolean)).toEqual([
        "second",
      ]);
    });
  });

  it("holds when a stop lands while the turn start is still being located", async () => {
    // Catches: the stop gate being checked only before the drain, so a stop issued
    // while it is in flight leaves a cursor past the stopped turn's boundary and the
    // gate then swallows this turn's chunks and its own boundary.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = stubSession({
      retained: answerRecords(1, "done: one", 1),
      inSeq: 2,
      recordsGate: gate,
      onAppend: () => {},
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-stop-in-drain", session: {} });
      const sending = chat.sendRaw([
        { id: "u3", role: "user", parts: [{ type: "text", text: "three" }] },
      ]);
      await vi.waitFor(() => expect(session.recordsCalls).toHaveLength(1));

      // The drain is in flight: a stop lands, the stopped turn (message 2) ends,
      // and this turn (message 3) is answered, all before the drain reads the log.
      await chat.stop();
      session.log.push({ seq: 5, boundary: true, inCursor: 2 }, ...answerRecords(6, "second", 3));
      release();

      const chunks = await drain(await sending);

      expect(chunks.map((c) => (c as { delta?: string }).delta).filter(Boolean)).toEqual([
        "second",
      ]);
    });
  });

  it("starts after an earlier boundary that carries no cursor, and holds until its own", async () => {
    // Catches: a header-less boundary (a turn started from the session's start
    // payload) being taken for the send's own and closing the stream on it, so
    // the new turn is never read; or the turn after it streaming ahead of a
    // boundary that says whose it is, on an agent that doesn't mark its turns.
    stubSession({
      retained: [
        { seq: 1, chunk: { type: "text-delta", id: "a", delta: "done: one" } },
        { seq: 2, boundary: true },
      ],
      inSeq: 1,
      onAppend: (inSeq, log) => log.push(...answerRecords(3, "answer ", inSeq)),
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-headerless", session: {} });
      const chunks = await drain(
        await chat.sendRaw([{ id: "u2", role: "user", parts: [{ type: "text", text: "two" }] }])
      );
      expect(chunks.map((c) => (c as { delta?: string }).delta).filter(Boolean)).toEqual([
        "answer ",
      ]);
    });
  });

  it("streams the first message of a new chat without holding the answer back", async () => {
    // Catches: buffering the first turn of a brand-new chat (nothing earlier to
    // discard) until its boundary, which would end token-by-token streaming.
    let releaseBoundary: () => void = () => {};
    const boundaryWritten = new Promise<void>((resolve) => {
      releaseBoundary = resolve;
    });
    global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (/\/api\/v1\/sessions\/?$/.test(urlStr)) {
        return createSessionResponse("chat-new", false);
      }
      if (urlStr.endsWith("/in/append")) return appendOkResponse(1);
      if (urlStr.endsWith("/out")) {
        const first = sseBatch([{ seq: 1, chunk: { type: "text-start", id: "t" } }]);
        const rest = sseBatch([{ seq: 2, turnComplete: true, inCursor: 1 }]);
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(first));
            await boundaryWritten;
            controller.enqueue(new TextEncoder().encode(rest));
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "X-Stream-Version": "v2" },
        });
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    }) as never;

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-new" });
      const stream = await chat.sendRaw([
        { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ]);
      const reader = stream.getReader();

      // The first chunk arrives while the boundary has not been written yet.
      const first = await reader.read();
      expect(first.value).toEqual({ type: "text-start", id: "t" });

      releaseBoundary();
      expect((await reader.read()).done).toBe(true);
    });
  });

  it("does not close on an earlier turn's boundary when it already has a cursor", async () => {
    // Catches: closing on a boundary that belongs to an earlier turn (an action
    // that raced this send), which the browser transport already skips.
    stubSession({
      onAppend: (inSeq, log) => {
        log.push({ seq: 1, boundary: true, inCursor: 0 }, ...answerRecords(2, "mine", inSeq));
      },
    });

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-cursor",
        session: { lastEventId: "0" },
      });
      expect(await (await chat.sendMessage("hi")).text()).toBe("mine");
    });
  });

  describe("a send whose run died before its turn completed", () => {
    // The agent wrote part of the turn and the stream then ended for good: no
    // boundary and no settled marker will ever arrive.
    const partial = [
      { seq: 5, chunk: { type: "text-start", id: "t-3" } },
      { seq: 6, chunk: { type: "text-delta", id: "t-3", delta: "half an ans" } },
    ];

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function expectBudgetError(stream: Promise<{ text(): Promise<string> }>) {
      const outcome = stream.then((response) => response.text());
      const settled = expect(outcome).rejects.toThrow(/reconnect budget exhausted/);
      // The backoff between resubscribes is a timer: run them all.
      await vi.runAllTimersAsync();
      await settled;
    }

    it("errors once the reconnect budget is spent when it holds a saved cursor", async () => {
      // Catches: a send with a cursor waiting forever for a boundary that a dead
      // run will never write, instead of ending once the resubscribes run out.
      const { outCalls } = stubSession({
        retained: answerRecords(1, "done: one", 1),
        inSeq: 2,
        onAppend: (_inSeq, records) => records.push(...partial),
      });

      await withApiContext(async () => {
        const chat = new AgentChat({
          agent: "test-agent",
          id: "chat-dead-cursor",
          session: { lastEventId: "4" },
        });
        await expectBudgetError(chat.sendMessage("after"));
        // The read that delivered the chunks, plus the budget of resubscribes.
        expect(outCalls).toHaveLength(6);
      });
    });

    it("errors once the reconnect budget is spent when it located its turn start", async () => {
      // Catches: the live cursorless path (no held chunks) hanging on a turn
      // that stops partway, because its stream never sees a boundary of its own.
      let releaseOut: () => void = () => {};
      const outGate = new Promise<void>((resolve) => {
        releaseOut = resolve;
      });
      const { outCalls, log } = stubSession({
        retained: answerRecords(1, "done: one", 1),
        inSeq: 2,
        records: "headers",
        outGate,
        onAppend: () => {},
      });

      await withApiContext(async () => {
        const chat = new AgentChat({ agent: "test-agent", id: "chat-dead-live", session: {} });
        const response = chat.sendMessage("after");
        const outcome = response.then(async (r) => {
          log.push(...partial);
          releaseOut();
          return r.text();
        });
        const settled = expect(outcome).rejects.toThrow(/reconnect budget exhausted/);
        await vi.runAllTimersAsync();
        await settled;
        expect(outCalls).toHaveLength(6);
      });
    });

    it("errors once the reconnect budget is spent when it holds chunks for a boundary", async () => {
      // Catches: hold mode (no cursor, the lookup can't tell) waiting forever on
      // chunks it never got a boundary for, instead of ending the stream.
      const { outCalls } = stubSession({
        retained: answerRecords(1, "done: one", 1),
        inSeq: 2,
        records: "unavailable",
        onAppend: (_inSeq, records) => records.push(...partial),
      });

      await withApiContext(async () => {
        const chat = new AgentChat({ agent: "test-agent", id: "chat-dead-hold", session: {} });
        await expectBudgetError(chat.sendMessage("after"));
        expect(outCalls.length).toBeGreaterThan(5);
      });
    });
  });

  describe("a recovery replay ahead of the send's own turn", () => {
    // A run that crashed mid-turn is replaced by one that re-answers each
    // unanswered message as its own turn, so `.out` carries an earlier message's
    // turn (chunks, then its boundary) after the client's cursor and ahead of the
    // turn for the message it just sent. The agent marks where each turn starts,
    // so the stream drops the replayed turn as it goes and delivers its own live.
    const turnOne = answerRecords(1, "done: one", 1);

    it("returns only the send's own answer when it holds a saved cursor", async () => {
      // Catches: a send resuming from its saved cursor handing back (or closing
      // on) the replayed earlier turn's output as its own answer.
      let releaseOut: () => void = () => {};
      const outGate = new Promise<void>((resolve) => {
        releaseOut = resolve;
      });
      const { log } = stubSession({
        retained: turnOne,
        inSeq: 2,
        outGate,
        // The earlier message sat at `.in` seq 2; this send lands at 3.
        onAppend: (inSeq, records) => {
          records.push(
            ...answerRecords(5, "replayed", inSeq - 1, { marked: true }),
            ...answerRecords(10, "mine", inSeq, { marked: true })
          );
        },
      });
      expect(log).toHaveLength(4);

      await withApiContext(async () => {
        const chat = new AgentChat({
          agent: "test-agent",
          id: "chat-replay-cursor",
          session: { lastEventId: "4" },
        });
        const response = await chat.sendMessage("after");
        releaseOut();

        expect(await response.text()).toBe("mine");
        expect(chat.session.lastEventId).toBe("14");
      });
    });

    it("returns only the send's own answer when the replay lands after the turn start is located", async () => {
      // Catches: the same wrong-turn answer on a cursorless send, whose lookup
      // finds the turn start before the replayed turn has been written and so
      // streams live from there.
      let releaseOut: () => void = () => {};
      const outGate = new Promise<void>((resolve) => {
        releaseOut = resolve;
      });
      const { log } = stubSession({
        retained: turnOne,
        inSeq: 2,
        records: "headers",
        outGate,
        onAppend: () => {},
      });

      await withApiContext(async () => {
        const chat = new AgentChat({ agent: "test-agent", id: "chat-replay-live", session: {} });
        const response = await chat.sendMessage("after");
        // The lookup saw only turn one; the replay is written after it.
        log.push(
          ...answerRecords(5, "replayed", 2, { marked: true }),
          ...answerRecords(10, "mine", 3, { marked: true })
        );
        releaseOut();

        expect(await response.text()).toBe("mine");
      });
    });
  });

  it("keeps a stopped cursorless turn open past an earlier turn's boundary", async () => {
    // Catches: the stopped stream closing at the first boundary it reads, which
    // on a replayed window is an earlier turn's, and so leaving before its own
    // turn's boundary has been written.
    const { outCalls, log } = stubSession({
      retained: answerRecords(1, "done: one", 1),
      inSeq: 1,
      onAppend: () => {},
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-stop-cursorless", session: {} });
      const stream = await chat.sendRaw([
        { id: "u2", role: "user", parts: [{ type: "text", text: "two" }] },
      ]);
      await chat.stop();
      // The stopped turn's boundary lands only after the first window has ended.
      setTimeout(() => log.push({ seq: 5, boundary: true, inCursor: 2 }), 20);

      expect(await drain(stream)).toHaveLength(0);
      expect(outCalls.length).toBeGreaterThan(1);
    });
  });
});

describe("AgentChat streaming around other turns and older agents", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const sleep = (ms: number) =>
    new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), ms));
  const earlierTurn = answerRecords(1, "done: one", 1);
  const ownStart: LogRecord[] = [
    { seq: 5, chunk: { type: "text-start", id: "own" } },
    { seq: 6, chunk: { type: "text-delta", id: "own", delta: "mine" } },
  ];
  const ownEnd = (inCursor: number): LogRecord[] => [
    { seq: 7, chunk: { type: "text-end", id: "own" } },
    { seq: 8, boundary: true, inCursor },
  ];
  const text = (chunks: UIMessageChunk[]) =>
    chunks.map((c) => (c as { delta?: string }).delta ?? "").join("");

  it("streams an older agent's turn live when nothing unanswered sits ahead of it", async () => {
    // Catches: holding every cursorless send's chunks until the boundary, which
    // costs live streaming even when the last earlier boundary shows the agent
    // had answered everything before this send.
    const { log } = stubSession({
      retained: [...earlierTurn, ...ownStart],
      inSeq: 1,
      onAppend: () => {},
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-live-old", session: {} });
      const reader = (
        await chat.sendRaw([{ id: "u2", role: "user", parts: [{ type: "text", text: "two" }] }])
      ).getReader();

      const first = await Promise.race([reader.read(), sleep(1_000)]);
      expect(first).not.toBe("idle");
      log.push(...ownEnd(2));
      const rest: UIMessageChunk[] = [];
      for (let r = await reader.read(); !r.done; r = await reader.read()) rest.push(r.value);
      expect(text(rest)).toBe("mine");
    });
  });

  it("holds an older agent's turn when an earlier message is still unanswered", async () => {
    // Catches: streaming live from the last earlier boundary when its cursor
    // says another message is waiting between it and this send, which hands back
    // that message's reply ahead of this send's own.
    const { log } = stubSession({
      retained: [...earlierTurn, ...ownStart],
      inSeq: 2,
      onAppend: () => {},
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-hold-old", session: {} });
      const reader = (
        await chat.sendRaw([{ id: "u3", role: "user", parts: [{ type: "text", text: "three" }] }])
      ).getReader();

      expect(await Promise.race([reader.read(), sleep(150)])).toBe("idle");
      log.push(...ownEnd(3));
      const chunks: UIMessageChunk[] = [];
      for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
      expect(text(chunks)).toBe("mine");
    });
  });

  it("streams live past an earlier boundary with no cursor when a later one carries one", async () => {
    // Catches: the turn-start lookup stopping at a boundary with no `.in` cursor
    // (a turn that answered no message) and holding the reply, when the later
    // boundary's cursor shows the agent had answered everything before this send.
    const { log } = stubSession({
      retained: [{ seq: 0, boundary: true }, ...earlierTurn, ...ownStart],
      inSeq: 1,
      onAppend: () => {},
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-live-mixed", session: {} });
      const reader = (
        await chat.sendRaw([{ id: "u2", role: "user", parts: [{ type: "text", text: "two" }] }])
      ).getReader();

      const first = await Promise.race([reader.read(), sleep(1_000)]);
      expect(first).not.toBe("idle");
      log.push(...ownEnd(2));
      const rest: UIMessageChunk[] = [];
      for (let r = await reader.read(); !r.done; r = await reader.read()) rest.push(r.value);
      expect(text(rest)).toBe("mine");
    });
  });

  it("reads only the send's own turn from an agent that writes no cursor at all", async () => {
    // Catches: the turn-start lookup taking the first of several boundaries with no
    // `.in` cursor as the send's own, so the read starts before the last earlier
    // turn and hands back that turn's reply instead of this send's.
    const delta = (seq: number, value: string): LogRecord => ({
      seq,
      chunk: { type: "text-delta", id: `t-${seq}`, delta: value },
    });
    const { log } = stubSession({
      retained: [
        delta(1, "one"),
        { seq: 2, boundary: true },
        delta(3, "prev"),
        { seq: 4, boundary: true },
      ],
      inSeq: 1,
      onAppend: () => {},
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-no-cursor", session: {} });
      const stream = await chat.sendRaw([
        { id: "u3", role: "user", parts: [{ type: "text", text: "three" }] },
      ]);
      // The agent answers after the send's lookup has run.
      log.push(delta(5, "answer"), { seq: 6, boundary: true });
      const chunks = await Promise.race([drain(stream), sleep(2_000)]);
      expect(chunks).not.toBe("idle");
      expect(text(chunks as UIMessageChunk[])).toBe("answer");
    });
  });

  it("delivers what it held, then the error, when the run dies mid-turn while holding", async () => {
    // Catches: a held turn ending in "reconnect budget exhausted" with none of
    // the partial output the run had written, where the same turn streamed live
    // would have delivered it before the error.
    vi.useFakeTimers();
    stubSession({
      retained: earlierTurn,
      inSeq: 2,
      records: "unavailable",
      onAppend: (_inSeq, log) => log.push(...ownStart),
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-dead-partial", session: {} });
      const received: UIMessageChunk[] = [];
      const outcome = chat
        .sendMessage("after")
        .then(async (response) => {
          for await (const chunk of response) received.push(chunk);
          return undefined;
        })
        .catch((error: Error) => error);
      await vi.runAllTimersAsync();

      expect(((await outcome) as Error).message).toMatch(/reconnect budget exhausted/);
      expect(text(received)).toBe("mine");
    });
  });

  it("holds an older agent's replies when the records endpoint isn't served, and returns only its own", async () => {
    // Catches: a path that serves `.out` but not `.out/records` (a proxy that
    // forwards only the stream), in front of an agent that writes no turn markers,
    // streaming the earlier replies still retained on `.out` live as part of the
    // answer ("done: one" + "mine").
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubSession({
      retained: earlierTurn,
      inSeq: 1,
      records: "fail",
      onAppend: (inSeq, log) => log.push(...answerRecords(5, "mine", inSeq)),
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-no-records-old", session: {} });
      const chunks = await drain(
        await chat.sendRaw([{ id: "u", role: "user", parts: [{ type: "text", text: "two" }] }])
      );
      expect(text(chunks)).toBe("mine");
    });
  });

  it("streams a marker-writing agent's turn live and warns once when the records endpoint isn't served", async () => {
    // Catches: a path that serves `.out` but not `.out/records` (a proxy that
    // forwards only the stream) holding a marked turn's answer back, or warning
    // on each send.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let release: () => void = () => {};
    const outGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { recordsCalls } = stubSession({
      retained: [],
      inSeq: 0,
      records: "fail",
      outGate,
      onAppend: (inSeq, log) => {
        if (inSeq === 1) log.push({ seq: 4, marker: { inSeq } }, ...ownStart);
      },
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-no-records", session: {} });
      const first = await chat.sendRaw([
        { id: "a", role: "user", parts: [{ type: "text", text: "a" }] },
      ]);
      const second = await chat.sendRaw([
        { id: "b", role: "user", parts: [{ type: "text", text: "b" }] },
      ]);
      release();

      const reader = first.getReader();
      const chunk = await Promise.race([reader.read(), sleep(1_000)]);
      expect(chunk).not.toBe("idle");
      await reader.cancel();
      expect(recordsCalls).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
      // The second send's stream is still reading: it drops the first turn as
      // another's and then reads that turn back with a records request (as it
      // should). Left running, that request lands after this test, on whichever
      // test's stubbed `fetch` is current, and shows up in its request counts.
      await second.cancel();
    });
  });

  it("resumes a turn on reconnect from its marker, ahead of nothing else", async () => {
    // Catches: reconnect() with no cursor holding a marked turn's chunks until
    // its boundary (no live streaming), or replaying the earlier turn before it.
    const { log } = stubSession({
      retained: answerRecords(1, "done: one", 1, { marked: true }),
      inSeq: 1,
      onAppend: (inSeq, l) => {
        l.push(
          { seq: 6, marker: { inSeq } },
          { seq: 7, chunk: { type: "text-delta", id: "own", delta: "mine" } }
        );
      },
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-reconnect-marker", session: {} });
      await (
        await chat.sendRaw([{ id: "u2", role: "user", parts: [{ type: "text", text: "two" }] }])
      ).cancel();
      const reader = (await chat.reconnect())!.getReader();

      const first = await Promise.race([reader.read(), sleep(1_000)]);
      expect(first).toMatchObject({ value: { delta: "mine" } });
      log.push({ seq: 8, boundary: true, inCursor: 2 });
      expect((await reader.read()).done).toBe(true);
    });
  });

  it("treats a turn-start with no message as nobody's own turn", async () => {
    // Catches: a turn the agent started from its start payload (a marker naming
    // no `.in` seq) being delivered as the answer to this send.
    stubSession({
      retained: [
        { seq: 1, marker: {} },
        { seq: 2, chunk: { type: "text-delta", id: "h", delta: "head start" } },
        { seq: 3, boundary: true },
      ],
      inSeq: 0,
      onAppend: (inSeq, log) => log.push(...answerRecords(4, "mine", inSeq, { marked: true })),
    });

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-head-start",
        session: { lastEventId: "0" },
      });
      const chunks = await drain(
        await chat.sendRaw([{ id: "u1", role: "user", parts: [{ type: "text", text: "one" }] }])
      );
      expect(text(chunks)).toBe("mine");
    });
  });

  for (const path of ["sendMessage", "sendRaw", "sendAction"] as const) {
    it(`posts a stop when ${path} is aborted before its stream starts`, async () => {
      // Catches: an abort that lands while the send is still locating its turn
      // posting no stop, so the agent runs (and bills) a turn nobody reads.
      const bodies: string[] = [];
      stubSession({
        retained: earlierTurn,
        inSeq: 1,
        onAppend: (_n, _log, body) => void bodies.push(body),
      });
      const controller = new AbortController();
      controller.abort();

      await withApiContext(async () => {
        const chat = new AgentChat({ agent: "test-agent", id: `chat-abort-${path}`, session: {} });
        const abortSignal = controller.signal;
        const stream =
          path === "sendMessage"
            ? await chat.sendMessage("hi", { abortSignal })
            : path === "sendRaw"
              ? await chat.sendRaw([{ id: "u", role: "user", parts: [] }], { abortSignal })
              : await chat.sendAction({ type: "undo" }, { abortSignal });
        void stream;
        await vi.waitFor(() => expect(bodies.some((b) => b.includes('"kind":"stop"'))).toBe(true));
        expect(bodies[0]).not.toContain('"kind":"stop"');
      });
    });
  }
  it("ends quietly, without the error, when the caller aborts while held chunks are unread", async () => {
    // Catches: a dead run's held chunks waiting forever on a consumer that
    // stopped reading after the caller aborted, instead of closing the stream.
    vi.useFakeTimers();
    stubSession({
      retained: earlierTurn,
      inSeq: 2,
      records: "unavailable",
      onAppend: (_inSeq, log) => log.push(...ownStart),
    });

    await withApiContext(async () => {
      const controller = new AbortController();
      const chat = new AgentChat({ agent: "test-agent", id: "chat-abort-drain", session: {} });
      const sending = chat.sendRaw(
        [{ id: "u3", role: "user", parts: [{ type: "text", text: "three" }] }],
        { abortSignal: controller.signal }
      );
      // Nobody reads: the run's budget runs out with the held chunks queued.
      await vi.runAllTimersAsync();
      const reader = (await sending).getReader();
      controller.abort();
      const received: UIMessageChunk[] = [];
      for (let r = await reader.read(); !r.done; r = await reader.read()) received.push(r.value);
      expect(text(received)).toBe("mine");
    });
  });
  it("does not move the cursor backwards when another stream advanced it during the turn-start lookup", async () => {
    // Catches: a slow turn-start lookup finishing after a later send's stream had
    // already advanced the shared cursor, and setting it back to its own older
    // boundary, so the next resume replays records already delivered.
    let releaseLookup: () => void = () => {};
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const options: Parameters<typeof stubSession>[0] = {
      retained: answerRecords(1, "done: one", 1),
      inSeq: 1,
      recordsGate: lookupGate,
      onAppend: (inSeq, log) =>
        log.push(...answerRecords((log.at(-1)?.seq ?? 0) + 1, `a${inSeq}`, inSeq)),
    };
    const session = stubSession(options);

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-monotonic", session: {} });
      // B's lookup is held at the gate; A's is not.
      const sendingB = chat.sendRaw([
        { id: "b", role: "user", parts: [{ type: "text", text: "b" }] },
      ]);
      await vi.waitFor(() => expect(session.recordsCalls).toHaveLength(1));
      options.recordsGate = undefined;
      const streamA = await chat.sendRaw([
        { id: "a", role: "user", parts: [{ type: "text", text: "a" }] },
      ]);
      await drain(streamA);
      const advanced = chat.session.lastEventId;

      releaseLookup();
      await sendingB;

      expect(Number(advanced)).toBeGreaterThan(4);
      expect(chat.session.lastEventId).toBe(advanced);
    });
  });
  it("does not hand a delivered chunk out again on reconnect after a marker made it live in hold mode", async () => {
    // Catches: in hold mode, live chunks (a matching `turn-start` marker made them
    // live) not advancing `session.lastEventId`, so a stream cancelled after a delta
    // and resumed with `reconnect()` delivers that delta a second time.
    const { log } = stubSession({
      retained: [],
      inSeq: 0,
      onAppend: (inSeq, l) =>
        l.push(
          { seq: 1, marker: { inSeq } },
          { seq: 2, chunk: { type: "text-start", id: "t" } },
          { seq: 3, chunk: { type: "text-delta", id: "t", delta: "a" } }
        ),
    });

    await withApiContext(async () => {
      // A saved cursor with nothing to prove it is this send's: the stream holds
      // until the marker, then streams live.
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-reconnect-dup",
        session: { lastEventId: "0" },
      });
      const stream = await chat.sendRaw([
        { id: "u", role: "user", parts: [{ type: "text", text: "go" }] },
      ]);
      const reader = stream.getReader();
      for (let r = await reader.read(); r.value?.type !== "text-delta"; r = await reader.read());
      await reader.cancel();
      log.push(
        { seq: 4, chunk: { type: "text-delta", id: "t", delta: "b" } },
        { seq: 5, chunk: { type: "text-end", id: "t" } },
        { seq: 6, boundary: true, inCursor: 1 }
      );

      const resumed = (await chat.reconnect())!;
      expect(text(await drain(resumed))).toBe("b");
    });
  });

  it("recovers a dropped turn that starts at seq 0 when the join marker is lost", async () => {
    // Catches: the read-back of a turn dropped as someone else's asking the records
    // route for `afterEventId=-1` when that turn begins at seq 0 (the first turn of
    // a session). The route accepts digits only and rejects it, so the send that was
    // folded into that turn ends with nothing.
    const session = stubSession({
      retained: [
        { seq: 0, marker: { inSeq: 5 } },
        { seq: 1, chunk: { type: "text-delta", id: "t", delta: "a" } },
        { seq: 2, boundary: true, inCursor: 7 },
      ],
      inSeq: 6,
      onAppend: () => {},
    });

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-seq-zero", session: {} });
      const chunks = await drain(
        await chat.sendRaw([{ id: "u", role: "user", parts: [{ type: "text", text: "go" }] }])
      );
      expect(session.recordsCalls).not.toContain("-1");
      expect(text(chunks)).toBe("a");
    });
  });

  const joinedTurn = (injectionId: string | undefined, afterJoin: unknown[]) =>
    stubSession({
      retained: [],
      inSeq: 1,
      onAppend: (inSeq, l) =>
        l.push(
          { seq: 1, marker: { inSeq: inSeq - 1 } },
          { seq: 2, join: { inSeqs: [inSeq], injectionId } },
          ...afterJoin.map((chunk, i) => ({ seq: 3 + i, chunk })),
          { seq: 3 + afterJoin.length, boundary: true, inCursor: inSeq }
        ),
    });
  const delta = (id: string, d: string) => ({ type: "text-delta", id, delta: d });

  it("starts a steered send after the injection chunk its join names, not at an earlier step's start-step", async () => {
    // Catches: a send folded into a running turn taking the previous step's batched
    // `start-step` (landing after the join) as the step that follows the injection.
    // The earlier step's tail lands after the join record, its `start-step` included.
    joinedTurn("inj-1", [
      { type: "start-step" },
      delta("t0", "before"),
      { type: "finish-step" },
      { type: "data-pending-message-injected", id: "inj-0", data: {} },
      { type: "data-pending-message-injected", id: "inj-1", data: {} },
      { type: "start-step" },
      delta("t1", "after"),
    ]);

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-join-id", session: {} });
      const chunks = await drain(
        await chat.sendRaw([{ id: "u", role: "user", parts: [{ type: "text", text: "go" }] }])
      );
      expect(text(chunks)).toBe("after");
    });
  });

  it("starts a steered send at the next start-step when its join names no injection chunk", async () => {
    // Catches: a join record without an injection id (none was written) leaving the
    // send waiting for a chunk that never comes, so it ends with nothing.
    joinedTurn(undefined, [
      delta("t0", "tail"),
      { type: "finish-step" },
      { type: "start-step" },
      delta("t1", "after"),
    ]);

    await withApiContext(async () => {
      const chat = new AgentChat({ agent: "test-agent", id: "chat-join-noid", session: {} });
      const chunks = await drain(
        await chat.sendRaw([{ id: "u", role: "user", parts: [{ type: "text", text: "go" }] }])
      );
      expect(text(chunks)).toBe("after");
    });
  });
});
