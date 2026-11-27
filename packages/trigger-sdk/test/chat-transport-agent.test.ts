import {
  mockChatAgent,
  type MockChatAgentHarness,
  type TestOutRecord,
} from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, stepCountIs, streamText, tool, type UIMessageChunk } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { chat } from "../src/v3/ai.js";
import { TriggerChatTransport, type ChatSessionPersistedState } from "../src/v3/chat.js";

/**
 * A real `TriggerChatTransport` against the real `chat.agent` runtime (the
 * in-process harness), joined by a loopback that serves `.in` / `.out` the way
 * the server does: an append gets the next `.in` seq and reaches the agent; a
 * read serves the records the agent has written, with their seqs and headers.
 */

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function textStream(text: string) {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
  return simulateReadableStream({ chunks });
}

function lastUserText(prompt: unknown): string {
  const msgs = Array.isArray(prompt) ? prompt : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: string; content?: unknown };
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return (m.content as Array<{ text?: string }>).map((p) => p?.text ?? "").join("");
    }
  }
  return "";
}

const userMessage = (text: string, id: string) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

let agentSeq = 0;

/** Gates keyed by message text; the model waits on a message's gate, if any. */
function gates() {
  const map = new Map<string, Promise<void>>();
  const gate = (text: string) => {
    let open!: () => void;
    map.set(
      text,
      new Promise<void>((resolve) => {
        open = resolve;
      })
    );
    return open;
  };
  return { gate, wait: (text: string) => map.get(text) };
}

/** An agent that answers `answer:<message>` once the message's gate (if any) opens. */
function gatedAgent() {
  const { gate, wait } = gates();
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const text = lastUserText(prompt);
      await wait(text);
      return { stream: textStream(`answer:${text}`) };
    },
  });
  const agent = chat.agent({
    id: `chat-transport-agent.${agentSeq++}`,
    run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
  });
  return { agent, gate };
}

/**
 * An agent that answers `a:<message>` `b:<message>` `c:<message>` as three
 * deltas, holding back the last two until the message's gate (if any) opens.
 */
function threePartAgent() {
  const { gate, wait } = gates();
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const text = lastUserText(prompt);
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          async start(controller) {
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: `a:${text}` });
            await wait(text);
            controller.enqueue({ type: "text-delta", id: "t1", delta: `b:${text}` });
            controller.enqueue({ type: "text-delta", id: "t1", delta: `c:${text}` });
            controller.enqueue({ type: "text-end", id: "t1" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: USAGE,
            });
            controller.close();
          },
        }),
      };
    },
  });
  const agent = chat.agent({
    id: `chat-transport-agent.${agentSeq++}`,
    run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
  });
  return { agent, gate };
}

/**
 * An agent whose first model step calls a slow tool and whose second answers
 * `steered`, with `pendingMessages` on, so a message sent while the tool runs is
 * folded into the running turn at the step boundary.
 */
function steeringAgent(extra: Record<string, unknown> = {}) {
  let release!: () => void;
  const toolGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let toolStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    toolStarted = resolve;
  });
  let calls = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      calls++;
      if (calls === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "plan" },
              { type: "text-delta", id: "plan", delta: "plan" },
              { type: "text-end", id: "plan" },
              { type: "tool-call", toolCallId: "c1", toolName: "slow", input: "{}" },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: USAGE,
              },
            ] as LanguageModelV3StreamPart[],
          }),
        };
      }
      return { stream: textStream("steered") };
    },
  });
  const agent = chat.agent({
    id: `chat-transport-agent.${agentSeq++}`,
    pendingMessages: { shouldInject: () => true },
    ...extra,
    run: async ({ messages, signal, streamText: managedStreamText }) =>
      managedStreamText({
        model,
        messages,
        abortSignal: signal,
        stopWhen: stepCountIs(5),
        tools: {
          slow: tool({
            description: "A slow tool",
            inputSchema: z.object({}),
            execute: async () => {
              toolStarted();
              await toolGate;
              return "done";
            },
          }),
        },
      }),
  });
  return { agent, release, started };
}

const wireRecord = (record: TestOutRecord) =>
  record.headers.length > 0
    ? {
        body: "",
        seq_num: record.seqNum,
        timestamp: 1700000000000 + record.seqNum,
        headers: record.headers,
      }
    : {
        body: JSON.stringify({ data: record.chunk, id: `p-${record.seqNum}` }),
        seq_num: record.seqNum,
        timestamp: 1700000000000 + record.seqNum,
        headers: [],
      };

type LoopbackOptions = {
  /** The next `.in` seq an append gets. */
  firstSeq?: number;
  /** Status the `.out/records` route answers with instead of the records (a proxy that doesn't serve it). */
  recordsStatus?: number;
  /** Holds every `.out` subscription until it settles. */
  outGate?: Promise<void>;
};

/** Serves the session endpoints the transport calls from the harness. */
function loopback(harness: MockChatAgentHarness, options: LoopbackOptions = {}) {
  let nextSeq = options.firstSeq ?? 1;
  const state = { recordReads: 0 };
  const original = global.fetch;
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith("/in/append")) {
      const seq = nextSeq++;
      await harness.deliverInput(JSON.parse(String(init?.body)), seq);
      return Response.json({ ok: true, seq });
    }
    if (urlStr.includes("/out/records")) {
      state.recordReads++;
      if (options.recordsStatus !== undefined) {
        return new Response("Not found", { status: options.recordsStatus });
      }
      const after = Number(new URL(urlStr).searchParams.get("afterEventId") ?? 0);
      return Response.json({
        records: harness.outRecords
          .filter((r) => r.seqNum > after)
          .map((r) => ({
            data: r.headers.length > 0 ? "" : r.chunk,
            id: String(r.seqNum),
            seqNum: r.seqNum,
            ...(r.headers.length > 0 ? { headers: r.headers } : {}),
          })),
      });
    }
    if (urlStr.endsWith("/out")) {
      await options.outGate;
      const after = Number(new Headers(init?.headers).get("Last-Event-ID") ?? 0);
      let sent = after;
      let off: (() => void) | undefined;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const flush = () => {
            const fresh = harness.outRecords.filter((r) => r.seqNum > sent);
            if (fresh.length === 0) return;
            sent = fresh.at(-1)!.seqNum;
            controller.enqueue(
              encoder.encode(
                `event: batch\ndata: ${JSON.stringify({ records: fresh.map(wireRecord) })}\n\n`
              )
            );
          };
          flush();
          off = harness.onOutRecord(flush);
          init?.signal?.addEventListener(
            "abort",
            () => {
              off?.();
              const err = new Error("aborted");
              err.name = "AbortError";
              try {
                controller.error(err);
              } catch {
                /* already closed */
              }
            },
            { once: true }
          );
        },
        cancel: () => off?.(),
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream", "X-Stream-Version": "v2" },
      });
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  }) as typeof fetch;
  return { state, restore: () => (global.fetch = original) };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const boundaries = (harness: MockChatAgentHarness) =>
  harness.outRecords.filter((r) => r.headers.some(([, v]) => v === "turn-complete")).length;

/** The text deltas of a stream, read to its end. */
async function deltas(stream: ReadableStream<UIMessageChunk>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) if (chunk.type === "text-delta") out.push(chunk.delta);
  return out;
}

/** Reads text deltas until one starts with `prefix`, failing if none comes within `ms`. */
async function readUntilDelta(
  reader: ReadableStreamDefaultReader<UIMessageChunk>,
  prefix: string,
  ms = 2_000
): Promise<string[]> {
  const seen: string[] = [];
  while (!seen.some((d) => d.startsWith(prefix))) {
    const next = await Promise.race([
      reader.read(),
      new Promise<"idle">((r) => setTimeout(() => r("idle"), ms)),
    ]);
    if (next === "idle" || next.done)
      throw new Error(`no "${prefix}" output before the turn ended`);
    if (next.value.type === "text-delta") seen.push(next.value.delta);
  }
  return seen;
}

/** Reads a stream for up to `ms`: the chunk types seen, and whether it ended. */
async function readWithin(stream: ReadableStream<UIMessageChunk>, ms: number) {
  const reader = stream.getReader();
  const types: string[] = [];
  const texts: string[] = [];
  let ended = false;
  const deadline = Date.now() + ms;
  let pending: ReturnType<typeof reader.read> | undefined;
  while (Date.now() < deadline) {
    pending ??= reader.read();
    const next = await Promise.race([
      pending,
      new Promise<"idle">((r) => setTimeout(() => r("idle"), 50)),
    ]);
    if (next === "idle") continue;
    pending = undefined;
    if (next.done) {
      ended = true;
      break;
    }
    types.push(next.value.type);
    if (next.value.type === "text-delta") texts.push(next.value.delta);
  }
  await reader.cancel().catch(() => {});
  return { ended, types, texts };
}

describe("TriggerChatTransport against a chat.agent run", () => {
  let restore: () => void = () => {};
  let harness: MockChatAgentHarness | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    restore();
    restore = () => {};
    await harness?.close();
    harness = undefined;
  });

  const start = (
    agent: { id: string },
    options: Parameters<typeof mockChatAgent>[1] = {},
    server: LoopbackOptions = {}
  ) => {
    harness = mockChatAgent(agent, { chatId: `chat-${agent.id}`, ...options });
    const loop = loopback(harness, {
      firstSeq: options.continuation ? 3 : 1,
      ...server,
    });
    restore = loop.restore;
    return { h: harness, server: loop.state };
  };

  /** A transport that knows the session (its token) but has no `.out` cursor unless given one. */
  const transportFor = (chatId: string, session: Partial<ChatSessionPersistedState> = {}) =>
    new TriggerChatTransport({
      task: "test-agent",
      accessToken: () => "pat_test",
      sessions: { [chatId]: { publicAccessToken: "pat_test", ...session } },
    });

  const send = (transport: TriggerChatTransport, chatId: string, text: string) =>
    transport.sendMessages({
      trigger: "submit-message",
      chatId,
      messageId: undefined,
      messages: [userMessage(text, `u-${text}`)],
      abortSignal: undefined,
    });

  // Catches: a cursorless send after a recovery replays two unread messages
  // streaming the replayed turns' answers as its own, ahead of its own
  // ("answer:first unread" + "answer:second unread" + "answer:mine"), because the
  // lookup found no earlier boundary and the stream ran live from the start.
  it("keeps a cursorless send to its own turn when a recovery replays two unread messages first", async () => {
    const { agent, gate } = gatedAgent();
    const open = gate("first unread");
    const { h } = start(agent, { continuation: true, previousRunId: "run_prior" });
    h.seedSessionInTail([
      userMessage("first unread", "u-1") as never,
      userMessage("second unread", "u-2") as never,
    ]);

    const stream = await send(transportFor(h.chatId), h.chatId, "mine");
    open();

    expect(await deltas(stream)).toEqual(["answer:mine"]);
  });

  // Catches: a cursorless send after a turn the agent started without a message
  // (a `chat.handover` first turn: its marker names no seq, its boundary carries
  // no cursor) taking that turn's answer as its own.
  it("answers a cursorless send that follows a turn the agent started without a message", async () => {
    const { agent } = gatedAgent();
    const { h } = start(
      agent,
      {
        mode: "handover-prepare",
        headStartMessages: [userMessage("head start", "u-head") as never],
      },
      { firstSeq: 2 }
    );
    await h.deliverInput({ kind: "handover", partialAssistantMessage: [], isFinal: false }, 1);
    await waitFor(() => boundaries(h) === 1, "the head-start turn to finish");

    const stream = await send(transportFor(h.chatId), h.chatId, "next");

    expect(await deltas(stream)).toEqual(["answer:next"]);
  });

  // Catches: a cursorless send after a turn started from the session's start
  // payload (its marker names no seq, its boundary carries no cursor) releasing
  // that turn's answer as its own, since a boundary with no cursor was never
  // taken for an earlier turn's.
  it("answers a cursorless send that follows a turn started from the start payload", async () => {
    const { agent } = gatedAgent();
    const { h } = start(agent, { mode: "submit-message" });
    await h.sendMessage(userMessage("boot", "u-boot") as never);
    expect(boundaries(h)).toBe(1);

    const stream = await send(transportFor(h.chatId), h.chatId, "next");

    expect(await deltas(stream)).toEqual(["answer:next"]);
  });

  // Catches: a reload in the middle of an answer (no saved cursor) either
  // replaying the earlier turn ahead of the one it resumes, or holding the
  // resumed turn's output until its boundary when the agent marks where it starts.
  it("resumes the turn in flight on a cursorless reconnect, live, without replaying earlier turns", async () => {
    const { agent, gate } = threePartAgent();
    const open = gate("two");
    const { h } = start(agent);

    const first = transportFor(h.chatId);
    expect(await deltas(await send(first, h.chatId, "one"))).toEqual(["a:one", "b:one", "c:one"]);
    const sent = await send(first, h.chatId, "two");
    await waitFor(
      () => h.outRecords.some((r) => (r.chunk as { delta?: string })?.delta === "a:two"),
      "the resumed turn's first output"
    );

    // The reload: the persisted session without its `.out` cursor.
    const { lastEventId: _dropped, ...persisted } = first.getSession(h.chatId)!;
    expect(persisted.isStreaming).toBe(true);
    await sent.cancel();
    const reloaded = transportFor(h.chatId, persisted);
    const resumed = await reloaded.reconnectToStream({ chatId: h.chatId });
    const reader = resumed!.getReader();

    expect(await readUntilDelta(reader, "a:")).toEqual(["a:two"]);
    open();
    const rest: string[] = [];
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      if (r.value.type === "text-delta") rest.push(r.value.delta);
    }
    expect(rest).toEqual(["b:two", "c:two"]);
  });

  // Catches: a send folded into the running turn by steering (it never gets a
  // turn of its own) delivering nothing, where the rest of that turn answers it.
  it("gives a message folded into a running turn the rest of that turn", async () => {
    const { agent, release, started } = steeringAgent();
    const { h } = start(agent);
    const transport = transportFor(h.chatId);

    await send(transport, h.chatId, "start");
    await started;
    const steer = await send(transport, h.chatId, "steer");
    await new Promise((r) => setTimeout(r, 100));
    release();

    const { ended, texts } = await readWithin(steer, 3_000);
    expect(texts).toEqual(["steered"]);
    expect(ended).toBe(true);
  });

  // Catches: a steered send with a queued action ahead of it skipping its turn's
  // boundary (the boundary's cursor sits below its seq, as the action is still
  // owed) and hanging after dropping what it held.
  it("ends a steered send at its turn's boundary when a queued action sits ahead of it", async () => {
    const { agent, release, started } = steeringAgent({
      actionSchema: z.object({ type: z.literal("undo") }),
      onAction: async () => chat.turn(),
    });
    const { h } = start(agent);
    const transport = transportFor(h.chatId);

    await send(transport, h.chatId, "start");
    await started;
    await transport.sendAction(h.chatId, { type: "undo" });
    const steer = await send(transport, h.chatId, "steer");
    await new Promise((r) => setTimeout(r, 100));
    release();

    const { ended, types, texts } = await readWithin(steer, 3_000);
    expect(texts).toEqual(["steered"]);
    expect(types.filter((t) => t === "finish")).toHaveLength(1);
    expect(ended).toBe(true);
  });

  // Catches: a send handing back the answer to a message another client sent
  // just before it, in flight when it subscribed.
  it("drops a turn another client's message started, and streams its own", async () => {
    const { agent, gate } = gatedAgent();
    const open = gate("theirs");
    // The other client's message takes `.in` seq 1; this transport's append gets 2.
    const { h } = start(agent, {}, { firstSeq: 2 });
    await h.deliverInput(
      {
        kind: "message",
        payload: {
          chatId: h.chatId,
          trigger: "submit-message",
          message: userMessage("theirs", "u-theirs"),
        },
      },
      1
    );
    await waitFor(() => h.outRecords.length > 0, "the other turn to start");

    const stream = await send(transportFor(h.chatId, { lastEventId: "0" }), h.chatId, "mine");
    open();

    expect(await deltas(stream)).toEqual(["answer:mine"]);
  });

  // Catches: a cursorless send to an agent that writes no turn markers streaming
  // live from the last earlier boundary when another message is still being
  // answered after it, which hands back that message's reply ahead of its own.
  it("holds an older agent's turn when an earlier message is still unanswered", async () => {
    const { agent, gate } = threePartAgent();
    const open = gate("two");
    // Both messages came from another client: this transport's append gets seq 3.
    const { h } = start(agent, { omitTurnMarkers: true }, { firstSeq: 3 });
    await h.deliverInput(
      {
        kind: "message",
        payload: { chatId: h.chatId, trigger: "submit-message", message: userMessage("one", "u1") },
      },
      1
    );
    await waitFor(() => boundaries(h) === 1, "the first turn to finish");
    await h.deliverInput(
      {
        kind: "message",
        payload: { chatId: h.chatId, trigger: "submit-message", message: userMessage("two", "u2") },
      },
      2
    );
    await waitFor(
      () => h.outRecords.some((r) => (r.chunk as { delta?: string })?.delta === "a:two"),
      "the second turn's first output"
    );

    const stream = await send(transportFor(h.chatId), h.chatId, "three");
    const texts: string[] = [];
    const reading = (async () => {
      for await (const chunk of stream) if (chunk.type === "text-delta") texts.push(chunk.delta);
    })();
    await new Promise((r) => setTimeout(r, 150));
    // Nothing is delivered while the earlier message's turn is still running.
    expect(texts).toEqual([]);
    open();
    await reading;
    expect(texts).toEqual(["a:three", "b:three", "c:three"]);
  });

  // A Stop is an ordinary `.in` record: it takes a seq between the last turn's
  // boundary cursor and the next send's, which the lookup can't tell from an owed
  // message. These pin what a cursorless send does with a realistic Stop in that gap.
  async function stopThenCursorlessSend(options: { omitTurnMarkers: boolean }) {
    const { agent, gate } = threePartAgent();
    const open = gate("two");
    const { h } = start(agent, options);
    const earlier = transportFor(h.chatId);
    expect(await deltas(await send(earlier, h.chatId, "one"))).toEqual(["a:one", "b:one", "c:one"]);
    // The Stop takes `.in` seq 2, after the first turn's boundary (cursor 1).
    expect(await earlier.stopGeneration(h.chatId)).toBe(true);
    // The send of a fresh transport (no cursor) takes seq 3.
    const stream = await send(transportFor(h.chatId), h.chatId, "two");
    return { stream, open, h };
  }

  // Catches: the quiet-tail hold taking a Stop's seq for an owed message and holding
  // a marker-writing agent's answer back until its boundary instead of streaming it.
  it("streams a marker-writing agent's answer live when a Stop sits between the last boundary and the send", async () => {
    const { stream, open, h } = await stopThenCursorlessSend({ omitTurnMarkers: false });
    const reader = stream.getReader();

    expect(await readUntilDelta(reader, "a:")).toEqual(["a:two"]);
    open();
    const rest: string[] = [];
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      if (r.value.type === "text-delta") rest.push(r.value.delta);
    }
    expect(rest).toEqual(["b:two", "c:two"]);
    expect(boundaries(h)).toBe(2);
  });

  // Documents: with an agent that writes no markers the same lookup holds the answer
  // until its boundary (a delay, not a leak): nothing is delivered while the turn
  // runs, then only this send's answer arrives, none of the first turn's. Without
  // the Stop's seq in the gap the same send streams live.
  it("holds an older agent's answer to its boundary when a Stop sits between the last boundary and the send, without leaking the earlier answer", async () => {
    const { stream, open, h } = await stopThenCursorlessSend({ omitTurnMarkers: true });
    const texts: string[] = [];
    const reading = (async () => {
      for await (const chunk of stream) if (chunk.type === "text-delta") texts.push(chunk.delta);
    })();
    // The agent has written the answer's first delta; a stream that delivered
    // live would have it by now (the short wait is for the stream to read it).
    await waitFor(
      () => h.outRecords.some((r) => (r.chunk as { delta?: string })?.delta === "a:two"),
      "the answer's first output"
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(texts).toEqual([]);
    open();
    await reading;

    expect(texts).toEqual(["a:two", "b:two", "c:two"]);
  });

  // Catches: a reload restoring a cursor the cursorless lookup persisted while it
  // was still holding (an earlier message's unmarked answer in flight after it):
  // the restored session has a cursor, so the lookup was skipped, nothing held,
  // and the earlier answer streamed into this send's.
  it("keeps holding an older agent's turn after a reload mid-lookup, when an earlier answer is in flight", async () => {
    const { agent, gate } = threePartAgent();
    const open = gate("two");
    const { h } = start(agent, { omitTurnMarkers: true }, { firstSeq: 3 });
    for (const [seq, text] of [
      [1, "one"],
      [2, "two"],
    ] as const) {
      await h.deliverInput(
        {
          kind: "message",
          payload: {
            chatId: h.chatId,
            trigger: "submit-message",
            message: userMessage(text, `u${seq}`),
          },
        },
        seq
      );
      if (seq === 1) await waitFor(() => boundaries(h) === 1, "the first turn to finish");
    }
    await waitFor(
      () => h.outRecords.some((r) => (r.chunk as { delta?: string })?.delta === "a:two"),
      "the second turn's first output"
    );

    const first = transportFor(h.chatId);
    const sent = await send(first, h.chatId, "three");
    const persisted = first.getSession(h.chatId)!;
    expect(persisted.isStreaming).toBe(true);
    await sent.cancel();

    const resumed = await transportFor(h.chatId, persisted).reconnectToStream({
      chatId: h.chatId,
    });
    const reading = deltas(resumed!);
    await new Promise((r) => setTimeout(r, 150));
    open();

    expect(await reading).toEqual(["a:three", "b:three", "c:three"]);
  });

  // Catches: a path that serves `.out` but not `.out/records` (a proxy that
  // forwards only the stream), in front of an agent that writes no turn markers,
  // streaming the earlier replies still retained on `.out` as part of the answer.
  it("holds an older agent's replies when the records endpoint isn't served, and returns only its own", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { agent } = gatedAgent();
    const { h } = start(agent, { omitTurnMarkers: true }, { recordsStatus: 404 });
    const earlier = transportFor(h.chatId);
    expect(await deltas(await send(earlier, h.chatId, "one"))).toEqual(["answer:one"]);

    const stream = await send(transportFor(h.chatId), h.chatId, "two");

    expect(await deltas(stream)).toEqual(["answer:two"]);
  });

  // Catches: the same proxy holding a marker-writing agent's answer back until
  // its boundary, or warning on every send rather than once.
  it("streams a marker-writing agent's turn live and warns once when the records endpoint isn't served", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let releaseOut: () => void = () => {};
    const outGate = new Promise<void>((resolve) => {
      releaseOut = resolve;
    });
    const { agent, gate } = threePartAgent();
    const open = gate("b");
    const { h, server } = start(agent, {}, { recordsStatus: 404, outGate });
    const transport = transportFor(h.chatId);

    // Both sends look their turn up before any `.out` read gives them a cursor.
    await send(transport, h.chatId, "a");
    const second = await send(transport, h.chatId, "b");
    expect(server.recordReads).toBe(2);
    releaseOut();

    const reader = second.getReader();
    expect(await readUntilDelta(reader, "a:b")).toEqual(["a:b"]);
    open();
    for (let r = await reader.read(); !r.done; r = await reader.read());
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
