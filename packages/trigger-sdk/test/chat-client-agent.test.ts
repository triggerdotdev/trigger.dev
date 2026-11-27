import {
  mockChatAgent,
  type MockChatAgentHarness,
  type TestOutRecord,
} from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { apiClientManager } from "@trigger.dev/core/v3";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { chat } from "../src/v3/ai.js";
import { AgentChat } from "../src/v3/chat-client.js";

/**
 * A real `AgentChat` against the real `chat.agent` runtime (the in-process
 * harness), joined by a loopback that serves `.in` / `.out` the way the server
 * does: an append gets the next `.in` seq and reaches the agent; a read serves
 * the records the agent has written, with their seqs and headers.
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

/** An agent that answers `answer:<message>` once the message's gate (if any) opens. */
function gatedAgent() {
  const gates = new Map<string, Promise<void>>();
  const gate = (text: string) => {
    let open!: () => void;
    gates.set(
      text,
      new Promise<void>((resolve) => {
        open = resolve;
      })
    );
    return open;
  };
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const text = lastUserText(prompt);
      await gates.get(text);
      return { stream: textStream(`answer:${text}`) };
    },
  });
  const agent = chat.agent({
    id: `chat-client-agent.${agentSeq++}`,
    run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
  });
  return { agent, gate };
}

/**
 * An agent whose first model step calls a slow tool and whose second answers
 * `steered`, with `pendingMessages` on, so a message sent while the tool runs is
 * folded into the running turn at the step boundary.
 */
function steeringAgent(extra: Record<string, unknown> = {}, options: { viaPipe?: boolean } = {}) {
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
    id: `chat-client-agent.${agentSeq++}`,
    pendingMessages: { shouldInject: () => true },
    ...extra,
    run: async ({ messages, signal, streamText: managedStreamText }) => {
      const result = managedStreamText({
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
      });
      if (!options.viaPipe) return result;
      // The documented manual form: the output goes out on its own pipe.
      await chat.pipe(result);
      return undefined;
    },
  });
  return { agent, release, started, modelCalls: () => calls };
}

/**
 * An agent that answers `<a|b|c>:<message>` as three text parts, holding back
 * the last two until the message's gate (if any) opens.
 */
function threePartAgent() {
  const gates = new Map<string, Promise<void>>();
  const gate = (text: string) => {
    let open!: () => void;
    gates.set(
      text,
      new Promise<void>((resolve) => {
        open = resolve;
      })
    );
    return open;
  };
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const text = lastUserText(prompt);
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          async start(controller) {
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: `a:${text}` });
            await gates.get(text);
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
    id: `chat-client-agent.${agentSeq++}`,
    run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
  });
  return { agent, gate };
}

function sessionResponse(externalId: string): Response {
  return Response.json({
    id: "session_test",
    externalId,
    type: "chat.agent",
    taskIdentifier: "test-agent",
    triggerConfig: { basePayload: { chatId: externalId } },
    currentRunId: "run_test",
    runId: "run_test",
    publicAccessToken: "pat_test",
    tags: [],
    metadata: null,
    closedAt: null,
    closedReason: null,
    expiresAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    isCached: true,
  });
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

/**
 * Serves the session endpoints from the harness. `firstSeq` is the next `.in`
 * seq an append gets; `outReads` counts the `.out` subscriptions that were opened.
 */
/** Records the loopback pretends `.out` never received. */
let hideRecord: ((record: TestOutRecord) => boolean) | undefined;
/** Holds each `.out/records` read (the lookup of a send's turn start) until it settles. */
let recordsGate: Promise<void> | undefined;

function loopback(harness: MockChatAgentHarness, firstSeq = 1) {
  const visible = () => harness.outRecords.filter((r) => !hideRecord?.(r));
  let nextSeq = firstSeq;
  const state = { outReads: 0, recordReads: 0 };
  const original = global.fetch;
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (/\/api\/v1\/sessions\/?$/.test(urlStr)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { externalId?: string };
      return sessionResponse(body.externalId ?? harness.chatId);
    }
    if (urlStr.endsWith("/in/append")) {
      const seq = nextSeq++;
      await harness.deliverInput(JSON.parse(String(init?.body)), seq);
      return Response.json({ ok: true, seq });
    }
    if (urlStr.includes("/out/records")) {
      state.recordReads++;
      await recordsGate;
      const after = Number(new URL(urlStr).searchParams.get("afterEventId") ?? 0);
      return Response.json({
        records: visible()
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
      state.outReads++;
      const after = Number(new Headers(init?.headers).get("Last-Event-ID") ?? 0);
      let sent = after;
      let off: (() => void) | undefined;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const flush = () => {
            const fresh = visible().filter((r) => r.seqNum > sent);
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

const withApiContext = <T>(fn: () => Promise<T>) =>
  apiClientManager.runWithConfig(
    { baseURL: "https://api.test.trigger.dev", secretKey: "tr_test_secret" },
    fn
  );

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

describe("AgentChat against a chat.agent run", () => {
  let restore: () => void = () => {};
  let harness: MockChatAgentHarness | undefined;

  beforeEach(() => {
    restore = () => {};
  });

  afterEach(async () => {
    hideRecord = undefined;
    recordsGate = undefined;
    restore();
    await harness?.close();
    harness = undefined;
  });

  const start = (
    agent: { id: string },
    options: Parameters<typeof mockChatAgent>[1] = {},
    firstInSeq = options.continuation ? 3 : 1
  ) => {
    harness = mockChatAgent(agent, { chatId: `chat-${agent.id}`, ...options });
    const server = loopback(harness, firstInSeq);
    restore = server.restore;
    return harness;
  };

  const connect = (
    id: string,
    session: { lastEventId?: string } = {},
    completed: Array<string | undefined> = []
  ) =>
    new AgentChat({
      agent: "test-agent",
      id,
      session,
      onTurnComplete: ({ lastEventId }) => {
        completed.push(lastEventId);
      },
    });

  it("gives each of two quick sends its own turn", async () => {
    // Catches: the second send taking the first send's turn (or the first
    // send's boundary clearing the second's state) when one instance sends
    // again before the first answer is read.
    const { agent, gate } = gatedAgent();
    const open = gate("one");
    const h = start(agent);
    const completed: Array<string | undefined> = [];

    await withApiContext(async () => {
      const client = connect(h.chatId, {}, completed);
      const first = await client.sendMessage("one");
      const second = await client.sendMessage("two");
      open();

      expect(await first.text()).toBe("answer:one");
      expect(await second.text()).toBe("answer:two");
      expect(completed).toHaveLength(2);
    });
  });

  it("keeps a send with a saved cursor to its own turn when a recovery replays two unread messages first", async () => {
    // Catches: a saved-cursor send streaming a replayed turn's text, ahead of
    // its own, as its answer ("replayed" + "mine").
    const { agent, gate } = gatedAgent();
    const open = gate("first unread");
    const h = start(agent, { continuation: true, previousRunId: "run_prior" });
    h.seedSessionInTail([
      userMessage("first unread", "u-1") as never,
      userMessage("second unread", "u-2") as never,
    ]);
    const completed: Array<string | undefined> = [];

    await withApiContext(async () => {
      const client = connect(h.chatId, { lastEventId: "0" }, completed);
      const stream = await client.sendMessage("mine");
      open();

      expect(await stream.text()).toBe("answer:mine");
      expect(completed).toHaveLength(1);
    });
  });

  it("keeps a saved-cursor send to its own turn against an older agent that replays unread messages first", async () => {
    // Catches: a second client resuming from a saved cursor that sits before a
    // replayed turn, against an agent that writes no turn markers, streaming the
    // replayed reply live as part of its own answer ("answer:first unread" +
    // "answer:second unread" + "answer:mine").
    const { agent, gate } = gatedAgent();
    const open = gate("first unread");
    const h = start(agent, {
      continuation: true,
      previousRunId: "run_prior",
      omitTurnMarkers: true,
    });
    h.seedSessionInTail([
      userMessage("first unread", "u-1") as never,
      userMessage("second unread", "u-2") as never,
    ]);

    await withApiContext(async () => {
      const client = connect(h.chatId, { lastEventId: "0" });
      const stream = await client.sendMessage("mine");
      open();

      expect(await stream.text()).toBe("answer:mine");
    });
  });

  it("keeps a cursorless send to its own turn when a recovery replays two unread messages first", async () => {
    // Catches: the same wrong-turn answer on a send with no saved cursor.
    const { agent, gate } = gatedAgent();
    const open = gate("first unread");
    const h = start(agent, { continuation: true, previousRunId: "run_prior" });
    h.seedSessionInTail([
      userMessage("first unread", "u-1") as never,
      userMessage("second unread", "u-2") as never,
    ]);

    await withApiContext(async () => {
      const client = connect(h.chatId);
      const stream = await client.sendMessage("mine");
      open();

      expect(await stream.text()).toBe("answer:mine");
    });
  });

  it("skips a turn another process's message started, and streams its own live", async () => {
    // Catches: a send handing back the answer to a message another client sent
    // just before it.
    const { agent, gate } = gatedAgent();
    const open = gate("theirs");
    // The other process's message takes `.in` seq 1; this client's append gets 2.
    const h = start(agent, {}, 2);
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

    await withApiContext(async () => {
      const client = connect(h.chatId, { lastEventId: "0" });
      const stream = await client.sendMessage("mine");
      const delivered: string[] = [];
      const reading = (async () => {
        for await (const part of stream) {
          if (part.type === "text-delta") delivered.push(part.delta);
        }
      })();
      // Nothing of the other turn is delivered while it is still running.
      open();
      await reading;
      expect(delivered).toEqual(["answer:mine"]);
    });
  });

  it("answers a cursorless send that follows a turn the agent started without a message", async () => {
    // Catches: a send after a head-start turn (which has no `.in` message of
    // its own) taking that turn's text, or holding the answer back.
    const { agent } = gatedAgent();
    const h = start(agent, {
      mode: "handover-prepare",
      headStartMessages: [userMessage("head start", "u-head") as never],
    });
    await h.deliverInput({ kind: "handover", partialAssistantMessage: [], isFinal: false }, 1);
    await waitFor(() => boundaries(h) === 1, "the head-start turn to finish");
    const loop = loopback(h, 2);
    restore = loop.restore;

    await withApiContext(async () => {
      const client = connect(h.chatId);
      const stream = await client.sendMessage("next");
      expect(await stream.text()).toBe("answer:next");
    });
  });

  it("resumes the turn in flight on reconnect without replaying earlier turns", async () => {
    // Catches: reconnect() with no cursor handing back the retained earlier
    // turns before the one still running.
    const { agent, gate } = gatedAgent();
    const open = gate("two");
    const h = start(agent);

    await withApiContext(async () => {
      const earlier = connect(h.chatId);
      expect(await (await earlier.sendMessage("one")).text()).toBe("answer:one");

      const client = connect(h.chatId);
      const sent = await client.sendRaw([userMessage("two", "u-two")]);
      await sent.cancel();
      const resumed = await client.reconnect();
      open();

      const parts: string[] = [];
      for await (const part of resumed as AsyncIterable<{ type: string; delta?: string }>) {
        if (part.type === "text-delta") parts.push(part.delta ?? "");
      }
      expect(parts).toEqual(["answer:two"]);
    });
  });
  it("gives a message folded into a running turn the rest of that turn", async () => {
    // Catches: a send absorbed into the running turn by steering (it never gets
    // a turn of its own) delivering nothing, where the turn's remaining output is
    // the answer to it.
    const { agent, release, started, modelCalls } = steeringAgent();
    const h = start(agent);
    const completed: Array<string | undefined> = [];

    await withApiContext(async () => {
      const client = connect(h.chatId, {}, completed);
      const first = await client.sendMessage("start");
      await started;
      const steer = await client.sendMessage("steer");
      await new Promise((r) => setTimeout(r, 100));
      release();

      expect(await steer.text()).toBe("steered");
      await first.text();
      expect(modelCalls()).toBe(2);
      expect(completed).toHaveLength(2);
    });
  });
  it("appends the turn-start marker while run() is still setting up", async () => {
    // Catches: the marker's append waiting for the turn's first output write, so
    // its round trip is added to the time to first chunk instead of overlapping
    // the work run() does before it returns the model stream.
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: textStream("ok") }) });
    const agent = chat.agent({
      id: `chat-client-agent.${agentSeq++}`,
      run: async ({ messages, signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return streamText({ model, messages, abortSignal: signal });
      },
    });
    const h = start(agent, { outAppendLatencyMs: 100 });

    const startedAt = performance.now();
    await h.sendMessage(userMessage("hi", "u-1") as never);
    const marker = h.outRecords.find((r) => r.headers.some(([, v]) => v === "turn-start"));
    // The append (100 ms) is acknowledged well inside run()'s 400 ms of setup.
    expect(marker!.at - startedAt).toBeLessThan(300);
  });
  it("streams its own turn's first output before the turn ends", async () => {
    // Catches: a marker-writing agent's output being held (or buffered) until
    // the boundary, when the point of marking turns is to stream live. Run for a
    // send with no saved cursor and for one with a saved cursor.
    const { agent, gate } = threePartAgent();
    const h = start(agent);
    const cases: Array<[{ lastEventId?: string }, string]> = [
      [{}, "slow-cursorless"],
      [{ lastEventId: "0" }, "slow-cursor"],
    ];
    let ran = 0;

    await withApiContext(async () => {
      for (const [session, text] of cases) {
        // The model holds back the rest of its answer until this opens.
        const open = gate(text);
        const client = connect(h.chatId, session);
        const reader = (await client.sendRaw([userMessage(text, `u-${text}`)])).getReader();
        const seen: string[] = [];
        while (!seen.some((d) => d.startsWith("a:"))) {
          const next = await Promise.race([
            reader.read(),
            new Promise<"idle">((r) => setTimeout(() => r("idle"), 2_000)),
          ]);
          if (next === "idle" || next.done) throw new Error("no output before the turn ended");
          if (next.value.type === "text-delta") seen.push(next.value.delta);
        }
        expect(seen).toEqual([`a:${text}`]);
        open();
        for (let r = await reader.read(); !r.done; r = await reader.read());
        ran++;
      }
    });
    expect(ran).toBe(2);
  });

  it("streams an older agent's turn live when this instance's last boundary proves nothing is unanswered", async () => {
    // Catches: holding every older-agent send that has a saved cursor, which costs
    // live streaming even when the instance read the previous turn's boundary and
    // that boundary shows the agent had answered everything before this message.
    const { agent, gate } = threePartAgent();
    const open = gate("slow");
    const h = start(agent, { omitTurnMarkers: true });

    await withApiContext(async () => {
      const client = connect(h.chatId, { lastEventId: "0" });
      // The first send has no proof yet and is held; its boundary becomes the proof.
      expect(await (await client.sendMessage("first")).text()).toBe("a:firstb:firstc:first");

      const reader = (await client.sendRaw([userMessage("slow", "u-slow")])).getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise<"idle">((r) => setTimeout(() => r("idle"), 2_000)),
      ]);
      expect(first).not.toBe("idle");
      open();
      for (let r = await reader.read(); !r.done; r = await reader.read());
    });
  });

  it("does not hand a cancelled send's turn to the next send", async () => {
    // Catches: after a send's stream is cancelled mid-turn (no stop, cursor left
    // inside that turn), the next send streaming the rest of the cancelled turn
    // as its own answer.
    const { agent, gate } = threePartAgent();
    const open = gate("one");
    const h = start(agent);

    await withApiContext(async () => {
      const client = connect(h.chatId);
      const first = (await client.sendRaw([userMessage("one", "u-one")])).getReader();
      for (let r = await first.read(); r.value?.type !== "text-delta"; r = await first.read());
      await first.cancel();
      const second = await client.sendMessage("two");
      open();

      expect(await second.text()).toBe("a:twob:twoc:two");
    });
  });

  it("starts a steered send at the next step even when the previous step's tail lands after the join", async () => {
    // Catches: the previous step's batched tail (a tool result without its call)
    // reaching a steered send, which then can't be folded into a message.
    const { agent, release, started } = steeringAgent();
    const h = start(agent, { outPipeLingerMs: 200 });

    await withApiContext(async () => {
      const client = connect(h.chatId);
      const first = await client.sendMessage("start");
      await started;
      const steer = await client.sendMessage("steer");
      await new Promise((r) => setTimeout(r, 400));
      release();

      const parts: string[] = [];
      for await (const message of steer.messages()) {
        parts.push(message.parts.map((p) => (p.type === "text" ? p.text : p.type)).join("|"));
      }
      expect(parts.at(-1)).toBe("step-start|steered");
      await first.text();
    });
  });

  it("falls back to the whole turn when a steered message's join marker is lost", async () => {
    // Catches: a send that was folded into a running turn, but whose join marker
    // failed to write, ending with no output where it used to get the turn.
    const { agent, release, started } = steeringAgent();
    const h = start(agent);

    await withApiContext(async () => {
      const client = connect(h.chatId);
      const first = await client.sendMessage("start");
      await started;
      const steer = await client.sendMessage("steer");
      await new Promise((r) => setTimeout(r, 100));
      // The join marker never reached `.out`, as a failed write would leave it.
      hideRecord = (r) => r.headers.some(([, v]) => v === "turn-join");
      release();

      expect(await steer.text()).toBe("plansteered");
      await first.text();
    });
  });
  it("marks the turns of an agent built on chat.createSession", async () => {
    // Catches: only `chat.agent`'s own loop writing the turn-start marker, so an
    // agent on `chat.customAgent` / `chat.createSession` falls back to holding.
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: textStream("ok") }) });
    // Ended with the test: a session left waiting for a next message keeps taking
    // `.in` messages meant for the tests that follow.
    const ended = new AbortController();
    const agent = chat.customAgent({
      id: `chat-client-agent.${agentSeq++}`,
      run: async (payload) => {
        const session = chat.createSession(payload, {
          signal: ended.signal,
          idleTimeoutInSeconds: 2,
        });
        for await (const turn of session) {
          await turn.complete(streamText({ model, messages: turn.messages }));
        }
      },
    });
    const h = start(agent);

    try {
      await withApiContext(async () => {
        const client = connect(h.chatId, { lastEventId: "0" });
        expect(await (await client.sendMessage("hi")).text()).toBe("ok");
      });
    } finally {
      ended.abort();
    }
    const marker = h.outRecords.find((r) => r.headers.some(([, v]) => v === "turn-start"));
    expect(marker, "no turn-start marker on .out").toBeDefined();
    expect(marker?.headers).toContainEqual(["turn-start-in-seq", "1"]);
    expect(marker!.seqNum).toBeLessThan(h.outRecords.find((r) => r.chunk !== undefined)!.seqNum);
  });
  it("marks the turns of a custom agent that reads chat.messages itself", async () => {
    // Catches: a hand-written loop over `chat.messages` (no `chat.createSession`)
    // writing no turn-start marker, so readers of its output fall back to holding.
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("raw") }),
    });
    const agent = chat.customAgent({
      id: `chat-client-agent.${agentSeq++}`,
      run: async () => {
        const next = await chat.messages.waitWithIdleTimeout({
          idleTimeoutInSeconds: 2,
          timeout: "1h",
        });
        if (!next.ok) return;
        const result = streamText({ model, prompt: "hi" });
        await chat.pipe(result.toUIMessageStream());
        await chat.writeTurnComplete();
      },
    });
    const h = start(agent);

    await withApiContext(async () => {
      const client = connect(h.chatId, { lastEventId: "0" });
      expect(await (await client.sendMessage("hi")).text()).toBe("raw");
    });
    const marker = h.outRecords.find((r) => r.headers.some(([, v]) => v === "turn-start"));
    expect(marker, "no turn-start marker on .out").toBeDefined();
    expect(marker?.headers).toContainEqual(["turn-start-in-seq", "1"]);
    expect(marker!.seqNum).toBeLessThan(h.outRecords.find((r) => r.chunk !== undefined)!.seqNum);
  });

  /**
   * Reads a stream to its end, or gives up after `ms` and reports what it saw.
   * One `read()` stays pending across the polling ticks, so a read that timed
   * out is not left behind to take the next chunk.
   */
  const readWithin = async (stream: ReadableStream<{ type: string }>, ms: number) => {
    const reader = stream.getReader();
    const types: string[] = [];
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
    }
    await reader.cancel().catch(() => {});
    return { ended, types };
  };

  it("ends a steered send at its turn's boundary when a recovered input before it is still unanswered", async () => {
    // Catches: a steered message whose turn closes with a `session-in-event-id`
    // below the message's seq (an earlier recovered input is still owed) skipping
    // that boundary as an earlier turn's, so the send reads on into the next turn's
    // output and `onTurnComplete` fires only at that turn's end.
    const { agent, release, started } = steeringAgent();
    const h = start(agent, { continuation: true, previousRunId: "run_prior" }, 3);
    h.seedSessionInTail([
      userMessage("start", "u-1") as never,
      userMessage("second unread", "u-2") as never,
    ]);

    await withApiContext(async () => {
      const client = connect(h.chatId);
      await started;
      const steer = await client.sendRaw([userMessage("steer", "u-steer")]);
      await new Promise((r) => setTimeout(r, 100));
      release();

      const { ended, types } = await readWithin(steer, 3_000);
      expect(types.filter((t) => t === "finish")).toHaveLength(1);
      expect(ended).toBe(true);
    });
  });

  it("reads a steered cursorless send's answer when its turn completes before the lookup of its start", async () => {
    // Catches: the lookup taking the boundary of the turn that my message was
    // folded into as an earlier turn's (it closes below my seq, an earlier input
    // is still owed), so it starts the read after my own answer and the send
    // ends empty or on the next turn.
    const { agent, release, started } = steeringAgent();
    const h = start(agent, { continuation: true, previousRunId: "run_prior" }, 3);
    h.seedSessionInTail([
      userMessage("start", "u-1") as never,
      userMessage("second unread", "u-2") as never,
    ]);

    await withApiContext(async () => {
      const completed: Array<string | undefined> = [];
      const client = connect(h.chatId, {}, completed);
      await started;
      let openRecords!: () => void;
      recordsGate = new Promise<void>((resolve) => {
        openRecords = resolve;
      });
      // The message is appended and steered into the running turn; the lookup
      // of where my turn starts waits at the gate.
      const sending = client.sendRaw([userMessage("steer", "u-steer")]);
      await new Promise((r) => setTimeout(r, 100));
      release();
      await waitFor(() => boundaries(h) >= 1, "the running turn's boundary");
      openRecords();

      const { ended, types } = await readWithin(await sending, 3_000);
      expect(types.filter((t) => t === "finish")).toHaveLength(1);
      expect(ended).toBe(true);
      // The send closed on the boundary of the turn that answered it, not on a later one.
      const own = h.outRecords.find((r) => r.headers.some(([, v]) => v === "turn-complete"))!;
      expect(completed).toEqual([String(own.seqNum)]);
    });
  });

  it("ends a steered send at its turn's boundary when a queued action sits ahead of it", async () => {
    // Catches: the same skipped boundary when what is owed ahead of the steered
    // message is an action queued behind the running turn.
    const { agent, release, started } = steeringAgent({
      actionSchema: z.object({ type: z.literal("undo") }),
      onAction: async () => chat.turn(),
    });
    const h = start(agent);

    await withApiContext(async () => {
      const client = connect(h.chatId);
      await client.sendMessage("start");
      await started;
      await client.sendAction({ type: "undo" });
      const steer = await client.sendRaw([userMessage("steer", "u-steer")]);
      await new Promise((r) => setTimeout(r, 100));
      release();

      const { ended, types } = await readWithin(steer, 3_000);
      expect(types.filter((t) => t === "finish")).toHaveLength(1);
      expect(ended).toBe(true);
    });
  });

  it("starts a steered send at the next step when the step before it began within the pipe linger of the join", async () => {
    // Catches: the "wait for the next start-step" rule matching the previous step's
    // own `start-step`, which lands after the join when that step started less than
    // the pipe's batching delay before the injection, so the steered send gets the
    // text from before it was injected ("plan" + "steered").
    const { agent, release, started } = steeringAgent();
    const h = start(agent, { outPipeLingerMs: 200 });

    await withApiContext(async () => {
      const client = connect(h.chatId);
      const first = await client.sendMessage("start");
      await started;
      const steer = await client.sendMessage("steer");
      // Short step: the join follows the first step's start by well under 200 ms.
      await new Promise((r) => setTimeout(r, 20));
      release();

      expect(await steer.text()).toBe("steered");
      await first.text();
    });
  });

  it("starts a steered send at the next step when the turn's output goes out through chat.pipe", async () => {
    // Catches: a join record naming an injection chunk that a `chat.pipe` turn writes on
    // a different pipe from its model output, so it can land after the step it
    // should precede and the steered send drops the whole answer waiting for it.
    const { agent, release, started } = steeringAgent({}, { viaPipe: true });
    const h = start(agent, { outAppendLatencyMs: 300 });

    await withApiContext(async () => {
      const client = connect(h.chatId);
      const first = await client.sendMessage("start");
      await started;
      const steer = await client.sendMessage("steer");
      await new Promise((r) => setTimeout(r, 20));
      release();

      expect(await steer.text()).toBe("steered");
      await first.text();
    });
  });
});
