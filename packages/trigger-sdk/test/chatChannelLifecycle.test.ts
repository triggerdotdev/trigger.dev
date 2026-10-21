import { mockChatAgent, recordingChannelConnector } from "../src/v3/test/index.js";

import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_TURN_ERROR_MESSAGE,
  chat,
  __makeChannelLifecycleReporterForTests,
  __setTranscriptStorageForTests,
  type AnyChannelConnector,
} from "../src/v3/ai.js";
import { webhooks } from "../src/v3/webhooks.js";
import { memoryTranscriptStorage } from "../src/v3/transcriptStorage.js";
import { simulateReadableStream, stepCountIs, streamText, tool, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod/v4";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function textStream(...deltas: string[]) {
  return simulateReadableStream({
    chunks: [
      { type: "text-start", id: "t1" },
      ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ] as LanguageModelV3StreamPart[],
  });
}

function slowTextStream(words: string[]) {
  return simulateReadableStream({
    chunks: [
      { type: "text-start", id: "t1" },
      ...words.map((w) => ({ type: "text-delta" as const, id: "t1", delta: w + " " })),
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ] as LanguageModelV3StreamPart[],
    initialDelayInMs: 0,
    chunkDelayInMs: 300,
  });
}

function toolCallStream(toolCallId: string, toolName: string, input: unknown, preamble?: string) {
  return simulateReadableStream({
    chunks: [
      ...(preamble
        ? [
            { type: "text-start", id: "p1" },
            { type: "text-delta", id: "p1", delta: preamble },
            { type: "text-end", id: "p1" },
          ]
        : []),
      { type: "tool-input-start", id: toolCallId, toolName },
      { type: "tool-input-delta", id: toolCallId, delta: JSON.stringify(input) },
      { type: "tool-input-end", id: toolCallId },
      { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
    ] as LanguageModelV3StreamPart[],
  });
}

async function waitFor(check: () => boolean, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

const requestApproval = tool({
  description: "Request human approval before acting.",
  inputSchema: z.object({ action: z.string() }),
});

type Event = { text?: string; threadId?: string; callback?: boolean; stop?: boolean; at?: number };

describe("chat.agent channel lifecycle", () => {
  it("reports working then idle around each turn, with the first turn and prompt", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("hello") }),
    });
    const channel = recordingChannelConnector<Event>({ lifecycle: true });
    const agent = chat.agent({
      id: "chatChannelLifecycle.basic",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "lc-basic" });
    try {
      await harness.sendChannelEvent({ event: { text: "first question", threadId: "lc-basic" } });
      await harness.sendChannelEvent({ event: { text: "second question", threadId: "lc-basic" } });
      expect(channel.lifecycles.map((l) => l.state)).toEqual([
        "working",
        "idle",
        "working",
        "idle",
      ]);
      expect(channel.lifecycles[0]!.ctx.firstTurn).toBe(true);
      expect(channel.lifecycles[0]!.ctx.prompt).toBe("first question");
      expect(channel.lifecycles[2]!.ctx.firstTurn).toBe(false);
      expect(channel.lifecycles[2]!.ctx.prompt).toBe("second question");
    } finally {
      await harness.close();
    }
  });

  it("goes idle after a turn that throws and after an empty reply", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("") }),
    });
    const channel = recordingChannelConnector<Event>({
      lifecycle: true,
      outbound: () => null,
    });
    const agent = chat.agent({
      id: "chatChannelLifecycle.cleanup",
      channels: [channel],
      run: async ({ messages, signal }) => {
        if (calls++ === 0) throw new Error("turn exploded");
        return streamText({ model, messages, abortSignal: signal });
      },
    });
    const harness = mockChatAgent(agent, { chatId: "lc-cleanup" });
    try {
      await harness.sendChannelEvent({ event: { text: "boom", threadId: "lc-cleanup" } });
      await harness.sendChannelEvent({ event: { text: "quiet", threadId: "lc-cleanup" } });
      expect(channel.lifecycles.map((l) => l.state)).toEqual([
        "working",
        "idle",
        "working",
        "idle",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("reports waiting on a human decision and working again when the click resumes it", async () => {
    const TC = "tc_lc_wait";
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream:
          call++ === 0
            ? toolCallStream(TC, "requestApproval", { action: "refund" })
            : textStream("refund issued"),
      }),
    });
    const channel = recordingChannelConnector<Event>({
      lifecycle: true,
      renderInteraction: () => ({ text: "Approve?" }),
      onInteraction: (e) => (e?.callback ? { toolCallId: TC, output: { approved: true } } : null),
    });
    const agent = chat.agent({
      id: "chatChannelLifecycle.waiting",
      channels: [channel],
      run: async ({ messages, signal }) =>
        streamText({ model, messages, tools: { requestApproval }, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "lc-wait" });
    try {
      await harness.sendChannelEvent({ event: { text: "refund me", threadId: "lc-wait" } });
      expect(channel.lifecycles.map((l) => l.state)).toEqual(["working", "waiting"]);
      await harness.sendChannelEvent({ event: { callback: true } });
      expect(channel.lifecycles.map((l) => l.state)).toEqual([
        "working",
        "waiting",
        "working",
        "idle",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("goes idle when a repeated delivery runs no model", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("hello") }),
    });
    const channel = recordingChannelConnector<Event>({ lifecycle: true });
    const agent = chat.agent({
      id: "chatChannelLifecycle.noop",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "lc-noop" });
    try {
      const event = { text: "hi", threadId: "lc-noop" };
      await harness.sendChannelEvent({ event, deliveryId: "dlv_same" });
      await harness.sendChannelEvent({ event, deliveryId: "dlv_same" });
      expect(model.doStreamCalls).toHaveLength(1);
      expect(channel.lifecycles.map((l) => l.state)).toEqual([
        "working",
        "idle",
        "working",
        "idle",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("reports closed when run() closes the conversation", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("bye") }),
    });
    const channel = recordingChannelConnector<Event>({ lifecycle: true });
    const agent = chat.agent({
      id: "chatChannelLifecycle.closed",
      channels: [channel],
      run: async ({ messages, signal }) => {
        chat.close({ reason: "done" });
        return streamText({ model, messages, abortSignal: signal });
      },
    });
    const harness = mockChatAgent(agent, { chatId: "lc-closed" });
    try {
      await harness.sendChannelEvent({ event: { text: "that is all", threadId: "lc-closed" } });
      await harness.waitForExit();
      expect(channel.lifecycles.map((l) => l.state)).toEqual(["working", "closed"]);
    } finally {
      await harness.close();
    }
  });
});

describe("chat.agent native channel streams", () => {
  it("feeds text deltas to the stream, ends it once, and does not post the reply again", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("Hello ", "**world**") }),
    });
    const channel = recordingChannelConnector<Event>({ stream: true, ack: null });
    const agent = chat.agent({
      id: "chatChannelLifecycle.stream",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "st-basic" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "st-basic" } });
      expect(channel.streams).toHaveLength(1);
      expect(channel.streams[0]!.deltas.join("")).toBe("Hello **world**");
      expect(channel.streams[0]!.endCalls).toBe(1);
      expect(channel.streams[0]!.ended).toEqual({ stopped: false, pending: false });
      expect(channel.sent).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("ends the stream with the connector's error line when the model fails", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "error", error: new Error("model exploded") },
          ] as LanguageModelV3StreamPart[],
        }),
      }),
    });
    const channel = recordingChannelConnector<Event>({ stream: true, ack: null });
    const agent = chat.agent({
      id: "chatChannelLifecycle.stream-error",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "st-error" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "st-error" } });
      expect(channel.streams[0]!.ended).toEqual({
        stopped: false,
        pending: false,
        errorText: CHANNEL_TURN_ERROR_MESSAGE,
      });
    } finally {
      await harness.close();
    }
  });

  it("passes a tool's declared title along with its progress", async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream:
          call++ === 0
            ? toolCallStream("tc_title", "lookupBuild", { buildId: "42" })
            : textStream("Build 42 failed."),
      }),
    });
    const lookupBuild = tool({
      title: "Look up the build",
      inputSchema: z.object({ buildId: z.string() }),
      execute: async () => ({ status: "failed" }),
    });
    const channel = recordingChannelConnector<Event>({ stream: true, ack: null, progress: true });
    const agent = chat.agent({
      id: "chatChannelLifecycle.tool-title",
      channels: [channel],
      run: async ({ messages, signal, streamText }) =>
        streamText({
          model,
          messages,
          tools: { lookupBuild },
          stopWhen: stepCountIs(3),
          abortSignal: signal,
        }),
    });
    const harness = mockChatAgent(agent, { chatId: "st-title" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "st-title" } });
      const progress = channel.streams[0]!.progress;
      expect(progress.map((p) => [p.type, p.toolName, p.title])).toEqual([
        ["tool-call", "lookupBuild", "Look up the build"],
        ["tool-result", "lookupBuild", "Look up the build"],
      ]);
      expect(channel.progressed.map((p) => p.event.title)).toEqual([
        "Look up the build",
        "Look up the build",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("reports tool progress to the stream and posts approval controls after ending it", async () => {
    const TC = "tc_st_pending";
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: toolCallStream(TC, "requestApproval", { action: "delete" }, "Checking first. "),
      }),
    });
    const channel = recordingChannelConnector<Event>({
      stream: true,
      ack: null,
      renderInteraction: (pending) => ({ text: `Approve ${pending[0]!.toolName}?` }),
    });
    const agent = chat.agent({
      id: "chatChannelLifecycle.stream-pending",
      channels: [channel],
      run: async ({ messages, signal }) =>
        streamText({ model, messages, tools: { requestApproval }, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "st-pending" });
    try {
      await harness.sendChannelEvent({ event: { text: "delete it", threadId: "st-pending" } });
      const stream = channel.streams[0]!;
      expect(stream.deltas.join("")).toBe("Checking first. ");
      expect(stream.progress.map((p) => p.type)).toEqual(["tool-call"]);
      expect(stream.ended).toEqual({ stopped: false, pending: true });
      expect(channel.sent.map((s) => s.message.text)).toEqual(["Approve requestApproval?"]);
    } finally {
      await harness.close();
    }
  });

  it("posts the whole reply through send() when a stream that saw text reports it undelivered", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("first ", "second") }),
    });
    const channel = recordingChannelConnector<Event>({ stream: { delivered: false }, ack: null });
    const agent = chat.agent({
      id: "chatChannelLifecycle.stream-undelivered",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "st-undelivered" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "st-undelivered" } });
      expect(channel.streams[0]!.deltas.join("")).toBe("first second");
      expect(channel.sent).toHaveLength(1);
      expect(channel.finalText()).toBe("first second");
    } finally {
      await harness.close();
    }
  });

  it("falls back to send() when nothing was streamed, and passes the error line to end()", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "error", error: new Error("model exploded") },
          ] as LanguageModelV3StreamPart[],
        }),
      }),
    });
    const channel = recordingChannelConnector<Event>({ stream: true, ack: null });
    const agent = chat.agent({
      id: "chatChannelLifecycle.stream-error",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "st-error" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "st-error" } });
      expect(channel.streams[0]!.ended).toEqual({
        stopped: false,
        pending: false,
        errorText: CHANNEL_TURN_ERROR_MESSAGE,
      });
      expect(channel.finalText()).toBe(CHANNEL_TURN_ERROR_MESSAGE);
    } finally {
      await harness.close();
    }
  });
});

describe("chat.agent interrupted channel streams", () => {
  it("saves the open stream while the turn runs and ends it when the next worker boots", async () => {
    const storage = memoryTranscriptStorage();
    let workerDied = false;
    __setTranscriptStorageForTests({
      ...storage,
      save: async (ctx, changeset) => {
        if (!workerDied) await storage.save(ctx, changeset);
      },
    });
    const bindingStream = () =>
      (
        storage.transcript("st-interrupted")?.state as {
          channelBinding?: { stream?: string };
        } | null
      )?.channelBinding?.stream;
    const slow = new MockLanguageModelV3({
      doStream: async () => ({ stream: slowTextStream(["one", "two", "three", "four", "five"]) }),
    });
    const quick = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("picked back up") }),
    });
    let model = slow;
    const channel = recordingChannelConnector<Event>({ stream: true, ack: null });
    const agent = chat.agent({
      id: "chatChannelLifecycle.interrupted",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const first = mockChatAgent(agent, { chatId: "st-interrupted" });
    try {
      void first
        .sendChannelEvent({ event: { text: "write it out", threadId: "st-interrupted" } })
        .catch(() => {});
      await waitFor(() => bindingStream() === "stream_1");
      expect(channel.streams[0]!.endCalls).toBe(0);
      workerDied = true;
    } finally {
      await first.close();
    }
    workerDied = false;

    model = quick;
    const second = mockChatAgent(agent, {
      chatId: "st-interrupted",
      continuation: true,
      previousRunId: "run_first",
    });
    try {
      await second.sendChannelEvent({
        event: { text: "still there?", threadId: "st-interrupted" },
      });
      expect(channel.interrupted.map((i) => i.ref)).toEqual(["stream_1"]);
      expect(channel.interrupted[0]!.ctx.handle).toEqual({ threadId: "st-interrupted" });
      const last = channel.streams[channel.streams.length - 1]!;
      expect(last.deltas.join("")).toBe("picked back up");
      expect(last.endCalls).toBe(1);
      expect(bindingStream()).toBeUndefined();
    } finally {
      __setTranscriptStorageForTests(undefined);
      await second.close();
    }
  });
});

describe("chat.agent channel stop controls", () => {
  it("a stop pressed before the latest turn started does not cancel that turn's approval", async () => {
    const TC = "tc_stale_stop";
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: toolCallStream(TC, "requestApproval", { action: "refund" }),
      }),
    });
    const channel = recordingChannelConnector<Event>({
      ack: null,
      onControl: (e) =>
        e?.stop ? { kind: "stop" as const, whenIdle: "drop" as const, at: e.at } : null,
      renderInteraction: () => ({ text: "Approve?" }),
      onInteraction: (e) => (e?.callback ? { toolCallId: TC, output: { approved: true } } : null),
    });
    const agent = chat.agent({
      id: "chatChannelLifecycle.stale-idle-stop",
      channels: [channel],
      run: async ({ messages, signal }) =>
        streamText({ model, messages, tools: { requestApproval }, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "stop-stale-idle" });
    try {
      const pressedAt = Date.now() - 60_000;
      await harness.sendChannelEvent({ event: { text: "refund", threadId: "stop-stale-idle" } });
      await harness.deliverChannelEvent({
        event: { stop: true, threadId: "stop-stale-idle", at: pressedAt },
      });
      expect(channel.cancelled).toHaveLength(0);
      await harness.sendChannelEvent({ event: { callback: true } });
      expect(channel.finalized).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("a stop pressed while the turn ran but delivered after it ended is consumed, a later one runs", async () => {
    let turns = 0;
    let pressedDuringTurn = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("done") }),
    });
    const channel = recordingChannelConnector<Event>({
      inbound: (e) => ({ message: e?.stop ? "please stop" : (e?.text ?? "") }),
      onControl: (e) => (e?.stop ? { kind: "stop" as const, at: e.at } : null),
    });
    const agent = chat.agent({
      id: "chatChannelLifecycle.late-stop",
      channels: [channel],
      onTurnStart: async () => {
        turns++;
        pressedDuringTurn = Date.now();
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "stop-late" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "stop-late" } });
      await harness.deliverChannelEvent({
        event: { stop: true, threadId: "stop-late", at: pressedDuringTurn },
      });
      expect(turns).toBe(1);
      await new Promise((r) => setTimeout(r, 5));
      await harness.sendChannelEvent({
        event: { stop: true, threadId: "stop-late", at: Date.now() },
      });
      expect(turns).toBe(2);
    } finally {
      await harness.close();
    }
  });

  const stopControl = (e: Event | undefined) =>
    e?.stop ? { kind: "stop" as const, whenIdle: "drop" as const, at: e.at } : null;

  it("drops a stop that arrives while idle without running a turn", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls++;
        return { stream: textStream("answer") };
      },
    });
    const channel = recordingChannelConnector<Event>({ lifecycle: true, onControl: stopControl });
    const agent = chat.agent({
      id: "chatChannelLifecycle.idle-drop",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "stop-idle" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "stop-idle" } });
      const sentBefore = channel.sent.length;
      await harness.deliverChannelEvent({ event: { stop: true, threadId: "stop-idle" } });
      await harness.deliverChannelEvent({ event: { stop: true, threadId: "stop-idle" } });
      expect(modelCalls).toBe(1);
      expect(channel.sent).toHaveLength(sentBefore);
      expect(channel.lifecycles.map((l) => l.state)).toEqual(["working", "idle"]);

      await harness.sendChannelEvent({ event: { text: "again", threadId: "stop-idle" } });
      expect(modelCalls).toBe(2);
      expect(channel.finalText()).toBe("answer");
    } finally {
      await harness.close();
    }
  });

  it("stops the running turn, keeps the partial, and the next message continues", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: slowTextStream(["one", "two", "three", "four", "five", "six", "seven", "eight"]),
      }),
    });
    const channel = recordingChannelConnector<Event>({
      lifecycle: true,
      stream: true,
      ack: null,
      onControl: stopControl,
    });
    const agent = chat.agent({
      id: "chatChannelLifecycle.stop-running",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "stop-running" });
    try {
      const first = harness.sendChannelEvent({
        event: { text: "long essay", threadId: "stop-running" },
      });
      await waitFor(() => (channel.streams[0]?.deltas.length ?? 0) >= 2);
      await harness.deliverChannelEvent({
        event: { stop: true, threadId: "stop-running", at: Date.now() },
      });
      await first;
      const stream = channel.streams[0]!;
      expect(stream.ended?.stopped).toBe(true);
      expect(stream.deltas.join("")).not.toContain("eight");
      expect(channel.lifecycles.map((l) => l.state)).toEqual(["working", "idle"]);

      await harness.sendChannelEvent({ event: { text: "short", threadId: "stop-running" } });
      expect(channel.streams).toHaveLength(2);
      expect(channel.streams[1]!.ended?.stopped).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("ignores a stop meant for an earlier turn while a later turn runs", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: slowTextStream(["a", "b", "c", "d", "e"]) }),
    });
    const channel = recordingChannelConnector<Event>({
      stream: true,
      ack: null,
      onControl: stopControl,
    });
    let turns = 0;
    const agent = chat.agent({
      id: "chatChannelLifecycle.stale-stop",
      channels: [channel],
      onTurnStart: async () => {
        turns++;
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "stop-stale" });
    try {
      const pressedAt = Date.now() - 60_000;
      const turn = harness.sendChannelEvent({ event: { text: "go", threadId: "stop-stale" } });
      await waitFor(() => (channel.streams[0]?.deltas.length ?? 0) >= 1);
      await harness.deliverChannelEvent({
        event: { stop: true, threadId: "stop-stale", at: pressedAt },
      });
      await turn;
      expect(channel.streams[0]!.ended?.stopped).toBe(false);
      expect(channel.streams[0]!.deltas.join("")).toBe("a b c d e ");
      expect(turns).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it("a stop during an approval cancels the pending call, so a later click resumes nothing", async () => {
    const TC = "tc_stop_pending";
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls++;
        return {
          stream:
            modelCalls === 1
              ? toolCallStream(TC, "requestApproval", { action: "refund" }, "Checking the order. ")
              : textStream("after the stop"),
        };
      },
    });
    const channel = recordingChannelConnector<Event>({
      lifecycle: true,
      ack: null,
      onControl: stopControl,
      renderInteraction: () => ({ text: "Approve?" }),
      onInteraction: (e) => (e?.callback ? { toolCallId: TC, output: { approved: true } } : null),
    });
    const agent = chat.agent({
      id: "chatChannelLifecycle.stop-approval",
      channels: [channel],
      run: async ({ messages, signal }) =>
        streamText({ model, messages, tools: { requestApproval }, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "stop-approval" });
    try {
      await harness.sendChannelEvent({ event: { text: "refund", threadId: "stop-approval" } });
      const controlsRef = channel.sent[channel.sent.length - 1]!.ref;

      await harness.deliverChannelEvent({ event: { stop: true, threadId: "stop-approval" } });
      expect(channel.cancelled).toHaveLength(1);
      expect(channel.cancelled[0]!.cancelled).toEqual([
        {
          toolCallId: TC,
          toolName: "requestApproval",
          input: { action: "refund" },
          ref: controlsRef,
        },
      ]);
      expect(channel.lifecycles.map((l) => l.state)).toEqual(["working", "waiting", "idle"]);

      await harness.deliverChannelEvent({ event: { callback: true } });
      expect(channel.finalized).toHaveLength(0);
      expect(modelCalls).toBe(1);

      await harness.sendChannelEvent({ event: { text: "what now", threadId: "stop-approval" } });
      expect(modelCalls).toBe(2);
      expect(channel.finalText()).toBe("after the stop");
      const prompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
      expect(prompt.split(TC).length - 1).toBe(2);
      expect(prompt.split("Checking the order.").length - 1).toBe(1);
      expect(prompt).toContain("stopped");
    } finally {
      await harness.close();
    }
  });
});

describe("chat.agent bound channel turns", () => {
  const userMessage = (text: string, id: string): UIMessage => ({
    id,
    role: "user",
    parts: [{ type: "text", text }],
  });

  it("streams action and browser turns to the bound thread and user, across a worker restart", async () => {
    const storage = memoryTranscriptStorage();
    __setTranscriptStorageForTests(storage);
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("on it") }),
    });
    const channel = recordingChannelConnector<Event & { userId?: string }>({
      stream: true,
      lifecycle: true,
      ack: null,
      bind: (e) => (e?.threadId ? { threadId: e.threadId, userId: e.userId } : null),
    });
    const orderEvents = chat.event({
      id: "chatChannelLifecycle.bound.orders",
      endpoint: webhooks.endpoint.define({
        id: "chatChannelLifecycle-bound-orders",
        source: webhooks.custom<{ customer: string }>({
          scheme: "shared-secret",
          placement: "header",
          fieldName: "x-test-signature",
        }),
      }),
      key: "{event.customer}",
      type: "order.event",
    });
    const agent = chat.agent({
      id: "chatChannelLifecycle.bound",
      channels: [channel],
      events: [orderEvents],
      onAction: async () => chat.turn(),
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const handle = { threadId: "t-bound", userId: "U7" };

    const first = mockChatAgent(agent, { chatId: "bound-turns" });
    try {
      await first.sendChannelEvent({ event: { text: "hi", threadId: "t-bound", userId: "U7" } });
      await first.sendWebhookAction({
        type: "order.event",
        event: { customer: "c1" },
        source: "custom",
      });
      const actionStream = channel.streams[1]!;
      expect(actionStream.ctx).toMatchObject({ bound: true, handle });
      expect(actionStream.ctx.event).toBeUndefined();
      expect(actionStream.deltas.join("")).toBe("on it");
      const actionLifecycle = channel.lifecycles
        .slice(2)
        .map((l) => [l.state, l.ctx.bound, l.ctx.handle]);
      expect(actionLifecycle).toEqual([
        ["working", true, handle],
        ["idle", true, handle],
      ]);
    } finally {
      await first.close();
    }

    const second = mockChatAgent(agent, {
      chatId: "bound-turns",
      continuation: true,
      previousRunId: "run_first",
    });
    try {
      await second.sendMessage(userMessage("any update?", "u-browser-1"));
      const browserStream = channel.streams[channel.streams.length - 1]!;
      expect(browserStream.ctx).toMatchObject({ bound: true, handle });
      expect(browserStream.deltas.join("")).toBe("on it");
      expect(channel.sent).toHaveLength(0);
    } finally {
      __setTranscriptStorageForTests(undefined);
      await second.close();
    }
  });

  it("posts approval controls from a bound action turn, and a click in the thread resumes it", async () => {
    const TC = "tc_bound_approval";
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream:
          call++ === 1
            ? toolCallStream(TC, "requestApproval", { action: "refund" })
            : textStream(call === 1 ? "hello" : "refund issued"),
      }),
    });
    const rendered: unknown[] = [];
    const channel = recordingChannelConnector<Event>({
      lifecycle: true,
      ack: null,
      bind: (e) => (e?.threadId ? { threadId: e.threadId } : null),
      renderInteraction: (_pending, ctx) => {
        rendered.push(ctx);
        return { text: "Approve?" };
      },
      onInteraction: (e) => (e?.callback ? { toolCallId: TC, output: { approved: true } } : null),
    });
    const refundEvents = chat.event({
      id: "chatChannelLifecycle.bound.refunds",
      endpoint: webhooks.endpoint.define({
        id: "chatChannelLifecycle-bound-refunds",
        source: webhooks.custom<{ customer: string }>({
          scheme: "shared-secret",
          placement: "header",
          fieldName: "x-test-signature",
        }),
      }),
      key: "{event.customer}",
      type: "refund.requested",
    });
    const agent = chat.agent({
      id: "chatChannelLifecycle.bound.approval",
      channels: [channel],
      events: [refundEvents],
      onAction: async () => chat.turn(),
      run: async ({ messages, signal }) =>
        streamText({ model, messages, tools: { requestApproval }, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "bound-approval" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t-approval" } });
      await harness.sendWebhookAction({
        type: "refund.requested",
        event: { customer: "c1" },
        source: "custom",
      });
      const controls = channel.sent.find((s) => s.message.text === "Approve?");
      expect(controls?.ctx).toMatchObject({ bound: true, handle: { threadId: "t-approval" } });
      expect(rendered).toEqual([{}]);
      expect(channel.lifecycles.map((l) => l.state).slice(-1)).toEqual(["waiting"]);
      await harness.sendChannelEvent({ event: { callback: true, threadId: "t-approval" } });
      expect(channel.finalText()).toBe("refund issued");
      expect(channel.lifecycles.map((l) => l.state).slice(-2)).toEqual(["working", "idle"]);
    } finally {
      await harness.close();
    }
  });

  it("a worker that boots after a crash mid-turn sets the surface back to idle", async () => {
    const storage = memoryTranscriptStorage();
    let workerDied = false;
    __setTranscriptStorageForTests({
      ...storage,
      save: async (ctx, changeset) => {
        if (!workerDied) await storage.save(ctx, changeset);
      },
    });
    const working = () =>
      (
        storage.transcript("crash-status")?.state as {
          channelBinding?: { working?: boolean };
        } | null
      )?.channelBinding?.working;
    let model = new MockLanguageModelV3({
      doStream: async () => ({ stream: slowTextStream(["one", "two", "three", "four", "five"]) }),
    });
    const channel = recordingChannelConnector<Event>({ lifecycle: true, ack: null });
    const agent = chat.agent({
      id: "chatChannelLifecycle.crash-status",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const first = mockChatAgent(agent, { chatId: "crash-status" });
    try {
      void first
        .sendChannelEvent({ event: { text: "long one", threadId: "crash-status" } })
        .catch(() => {});
      await waitFor(() => working() === true);
      workerDied = true;
    } finally {
      await first.close();
    }
    workerDied = false;
    const firstWorkerReports = channel.lifecycles.length;

    model = new MockLanguageModelV3({ doStream: async () => ({ stream: textStream("back") }) });
    const second = mockChatAgent(agent, {
      chatId: "crash-status",
      continuation: true,
      previousRunId: "run_first",
    });
    try {
      await second.sendChannelEvent({ event: { text: "hello?", threadId: "crash-status" } });
      const reports = channel.lifecycles.slice(firstWorkerReports);
      expect(reports.map((l) => l.state)).toEqual(["idle", "working", "idle"]);
      expect(reports[0]!.ctx).toMatchObject({ bound: true, handle: { threadId: "crash-status" } });
      expect(working()).toBeUndefined();
    } finally {
      __setTranscriptStorageForTests(undefined);
      await second.close();
    }
  });

  it("stops a turn while a tool is running, and the next message runs", async () => {
    let toolStarted = false;
    let toolSawAbort = false;
    const slowTool = tool({
      description: "A slow lookup.",
      inputSchema: z.object({ q: z.string() }),
      execute: async (_input, { abortSignal }) =>
        new Promise((_resolve, reject) => {
          toolStarted = true;
          abortSignal?.addEventListener("abort", () => {
            toolSawAbort = true;
            reject(new Error("aborted"));
          });
        }),
    });
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream:
          call++ === 0
            ? toolCallStream("tc_slow", "slowTool", { q: "x" })
            : textStream("fresh answer"),
      }),
    });
    const channel = recordingChannelConnector<Event>({
      lifecycle: true,
      stream: true,
      ack: null,
      onControl: (e) => (e?.stop ? { kind: "stop", whenIdle: "drop", at: e.at } : null),
    });
    const agent = chat.agent({
      id: "chatChannelLifecycle.stop-tool",
      channels: [channel],
      tools: { slowTool },
      run: async ({ messages, tools, signal }) =>
        streamText({ model, messages, tools, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "stop-tool" });
    try {
      const turn = harness.sendChannelEvent({
        event: { text: "look it up", threadId: "stop-tool" },
      });
      await waitFor(() => toolStarted);
      await harness.deliverChannelEvent({
        event: { stop: true, threadId: "stop-tool", at: Date.now() },
      });
      await turn;
      expect(toolSawAbort).toBe(true);
      expect(channel.streams[0]!.ended?.stopped).toBe(true);
      expect(channel.streams[0]!.progress.map((p) => p.type)).toEqual(["tool-call"]);
      expect(channel.lifecycles.map((l) => l.state)).toEqual(["working", "idle"]);

      await harness.sendChannelEvent({ event: { text: "try again", threadId: "stop-tool" } });
      expect(channel.streams[1]!.deltas.join("")).toBe("fresh answer");
      expect(channel.lifecycles.map((l) => l.state)).toEqual([
        "working",
        "idle",
        "working",
        "idle",
      ]);
    } finally {
      await harness.close();
    }
  });
});

describe("channel lifecycle reporter", () => {
  it("re-sends working every 50 minutes until a newer report, then stops", async () => {
    vi.useFakeTimers();
    try {
      const reported: Array<{ state: string; refresh?: boolean }> = [];
      const connector = {
        lifecycle: (state: string, ctx: { refresh?: boolean }) => {
          reported.push({ state, refresh: ctx.refresh });
        },
      } as unknown as AnyChannelConnector;
      const reporter = __makeChannelLifecycleReporterForTests();
      await reporter.report(connector, "working", { bound: false, firstTurn: true });
      await vi.advanceTimersByTimeAsync(49 * 60 * 1000);
      expect(reported).toEqual([{ state: "working", refresh: undefined }]);
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(50 * 60 * 1000);
      expect(reported.map((r) => `${r.state}:${r.refresh ?? false}`)).toEqual([
        "working:false",
        "working:true",
        "working:true",
      ]);
      await reporter.report(connector, "idle", { bound: false, firstTurn: false });
      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
      expect(reported.map((r) => r.state)).toEqual(["working", "working", "working", "idle"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports closed once and nothing after it", async () => {
    const reported: string[] = [];
    const connector = {
      lifecycle: (state: string) => {
        reported.push(state);
      },
    } as unknown as AnyChannelConnector;
    const reporter = __makeChannelLifecycleReporterForTests();
    await reporter.report(connector, "closed", { bound: true, firstTurn: false });
    await reporter.report(connector, "closed", { bound: true, firstTurn: false });
    await reporter.report(connector, "idle", { bound: true, firstTurn: false });
    expect(reported).toEqual(["closed"]);
  });
});
