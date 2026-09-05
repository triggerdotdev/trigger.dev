import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { ModelMessage, UIMessage } from "ai";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { __setTranscriptStorageForTests, chat } from "../src/v3/ai.js";
import {
  createTranscriptShadow,
  memoryTranscriptStorage,
  prefixFingerprint,
  restoreModelLane,
  type MemoryTranscriptStorage,
  type TranscriptChange,
  type TranscriptRuntimeState,
} from "../src/v3/transcriptStorage.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function userMessage(text: string, id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function textChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ];
}

function promptText(prompt: unknown): string {
  return JSON.stringify(prompt);
}

function recordingModel(prompts: unknown[], reply = "ack") {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      return { stream: simulateReadableStream({ chunks: textChunks(reply) }) };
    },
  });
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const ops = (changes: TranscriptChange[]) => changes.map((c) => c.op);
const putIds = (changes: TranscriptChange[]) =>
  changes.flatMap((c) => (c.op === "put" ? [c.message.id] : []));
const stateOf = (changes: TranscriptChange[]) =>
  changes.find((c) => c.op === "state")?.value as TranscriptRuntimeState | null | undefined;

let storage: MemoryTranscriptStorage;

beforeEach(() => {
  storage = memoryTranscriptStorage();
  __setTranscriptStorageForTests(storage);
});

afterEach(() => {
  __setTranscriptStorageForTests(undefined);
});

describe("chat.agent transcript changesets", () => {
  it("saves a turn as puts for the new user and assistant messages with cursors", async () => {
    const prompts: unknown[] = [];
    const agent = chat.agent({
      id: "changeset-turn",
      run: async ({ messages, signal }) =>
        streamText({ model: recordingModel(prompts), messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "changeset-turn" });
    try {
      await harness.sendMessage(userMessage("hello", "u1"));
      await waitFor(() => storage.changesets.length === 1, "first save");

      const { ctx, changeset } = storage.changesets[0]!;
      expect(ctx.chatId).toBe("changeset-turn");
      expect(ctx.trigger).toBe("submit-message");
      expect(ctx.turn).toBe(0);
      expect(changeset.reason).toBe("turn-complete");
      expect(ops(changeset.changes)).toEqual(["put", "put"]);
      expect(putIds(changeset.changes)[0]).toBe("u1");
      expect(changeset.cursors?.lastOutEventId).toBeDefined();

      await harness.sendMessage(userMessage("again", "u2"));
      await waitFor(() => storage.changesets.length === 2, "second save");
      expect(ops(storage.changesets[1]!.changeset.changes)).toEqual(["put", "put"]);
      expect(putIds(storage.changesets[1]!.changeset.changes)[0]).toBe("u2");
      expect(storage.transcript("changeset-turn")!.entries.map((e) => e.message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("saves a stopped response with final: false and a completed one as final", async () => {
    const chatId = "changeset-stopped";
    const words = ["one", "two", "three", "four", "five", "six"];
    const slow = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            ...words.map((w) => ({ type: "text-delta" as const, id: "t1", delta: `${w} ` })),
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ] satisfies LanguageModelV3StreamPart[],
          initialDelayInMs: 0,
          chunkDelayInMs: 300,
        }),
      }),
    });
    const agent = chat.agent({
      id: "changeset-stopped",
      run: async ({ messages, signal }) =>
        streamText({ model: slow, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId });
    try {
      void harness.sendMessage(userMessage("go", "u1"));
      await waitFor(
        () =>
          (harness.allChunks as { type?: string }[]).filter((c) => c.type === "text-delta")
            .length >= 1,
        "first delta"
      );
      await harness.sendStop();
      await waitFor(() => storage.changesets.length === 1, "stopped turn save");

      const puts = storage.changesets[0]!.changeset.changes.filter((c) => c.op === "put");
      expect(puts).toHaveLength(2);
      expect(puts[0]).toMatchObject({ op: "put", message: { id: "u1" } });
      expect(puts[0]).not.toHaveProperty("final");
      expect(puts[1]).toMatchObject({ op: "put", message: { role: "assistant" }, final: false });
      expect(storage.transcript(chatId)!.entries.map((e) => e.final)).toEqual([true, false]);
    } finally {
      await harness.close();
    }
  });

  it("persists a conversational injection drained at a step boundary and restores it at boot", async () => {
    const chatId = "changeset-inject-step";
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "tool-input-start", id: "c1", toolName: "lookup" },
                { type: "tool-input-delta", id: "c1", delta: "{}" },
                { type: "tool-input-end", id: "c1" },
                { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage,
                },
              ] satisfies LanguageModelV3StreamPart[],
            }),
          };
        }
        stepPrompts.push(prompt);
        return { stream: simulateReadableStream({ chunks: textChunks("done") }) };
      },
    });
    const stepPrompts: unknown[] = [];
    const makeAgent = () =>
      chat.agent({
        id: "changeset-inject-step",
        tools: {
          lookup: tool({
            description: "look something up",
            inputSchema: z.object({}),
            execute: async () => {
              chat.inject([{ role: "user", content: "[note] drained at the step boundary" }]);
              return { ok: true };
            },
          }),
        },
        run: async ({ messages, tools, signal }) =>
          streamText({
            ...chat.toStreamTextOptions({ tools }),
            model,
            messages,
            abortSignal: signal,
            stopWhen: stepCountIs(5),
          }),
      });

    const first = mockChatAgent(makeAgent(), { chatId });
    try {
      await first.sendMessage(userMessage("look it up", "u1"));
      await waitFor(() => storage.changesets.length === 1, "turn save");

      expect(promptText(stepPrompts[0])).toContain("[note] drained at the step boundary");
      const state = stateOf(storage.changesets[0]!.changeset.changes);
      expect(state?.injections).toHaveLength(1);
      expect(state!.injections![0]!.afterId).toBe("u1");
    } finally {
      await first.close();
    }

    const second = mockChatAgent(makeAgent(), {
      chatId,
      continuation: true,
      previousRunId: "run_1",
    });
    try {
      call = 1;
      await second.sendMessage(userMessage("again", "u2"));
      await waitFor(() => stepPrompts.length === 2, "continuation turn");
      expect(promptText(stepPrompts[1])).toContain("[note] drained at the step boundary");
    } finally {
      await second.close();
    }
  });

  it("carries an injection that was still queued when the run ended into the continuation", async () => {
    const chatId = "changeset-inject-queued";
    let injectedOnce = false;
    const makeAgent = (prompts: unknown[]) =>
      chat.agent({
        id: "changeset-inject-queued",
        onTurnComplete: async () => {
          if (injectedOnce) return;
          injectedOnce = true;
          chat.inject([{ role: "user", content: "[note] queued at exit" } as ModelMessage]);
          chat.endRun();
        },
        run: async ({ messages, signal }) =>
          streamText({ model: recordingModel(prompts), messages, abortSignal: signal }),
      });

    const firstPrompts: unknown[] = [];
    const first = mockChatAgent(makeAgent(firstPrompts), { chatId });
    try {
      await first.sendMessage(userMessage("one", "u1"));
      await waitFor(() => storage.changesets.length === 1, "turn save");
      const state = stateOf(storage.changesets[0]!.changeset.changes);
      expect(state?.queued).toHaveLength(1);
      expect(state?.injections).toBeUndefined();
    } finally {
      await first.close();
    }

    const secondPrompts: unknown[] = [];
    const second = mockChatAgent(makeAgent(secondPrompts), {
      chatId,
      continuation: true,
      previousRunId: "run_1",
    });
    try {
      await second.sendMessage(userMessage("two", "u2"));
      await waitFor(() => storage.changesets.length === 2, "continuation save");
      expect(promptText(secondPrompts[0])).toContain("[note] queued at exit");
      const state = stateOf(storage.changesets[1]!.changeset.changes);
      expect(state?.queued).toBeUndefined();
      expect(state?.injections).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  it("puts a steering message the drain consumed into the turn's changeset", async () => {
    const send = { fn: async () => {} };
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          await send.fn();
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "tool-input-start", id: "c1", toolName: "lookup" },
                { type: "tool-input-delta", id: "c1", delta: "{}" },
                { type: "tool-input-end", id: "c1" },
                { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage,
                },
              ] satisfies LanguageModelV3StreamPart[],
            }),
          };
        }
        return { stream: simulateReadableStream({ chunks: textChunks("done") }) };
      },
    });

    const agent = chat.agent({
      id: "changeset-steer",
      tools: {
        lookup: tool({
          description: "look something up",
          inputSchema: z.object({}),
          execute: async () => ({ ok: true }),
        }),
      },
      pendingMessages: { shouldInject: ({ steps }) => steps.length > 0 },
      run: async ({ messages, tools, signal }) =>
        streamText({
          ...chat.toStreamTextOptions({ tools }),
          model,
          messages,
          abortSignal: signal,
          stopWhen: stepCountIs(5),
        }),
    });
    const harness = mockChatAgent(agent, { chatId: "changeset-steer" });
    send.fn = async () => {
      await harness.sendPendingMessage(userMessage("only the platform one", "steer-1"));
    };
    try {
      await harness.sendMessage(userMessage("summarise every project", "u1"));
      await waitFor(() => storage.changesets.length === 1, "save");

      const ids = putIds(storage.changesets[0]!.changeset.changes);
      expect(ids).toContain("steer-1");
      expect(ids.indexOf("steer-1")).toBeGreaterThan(ids.indexOf("u1"));
      expect(storage.transcript("changeset-steer")!.entries.map((e) => e.id)).toEqual(ids);
    } finally {
      await harness.close();
    }
  });

  it("persists a compaction as state and boots a continuation from the summary", async () => {
    const chatId = "changeset-compaction";
    let compactions = 0;
    const makeAgent = (prompts: unknown[]) =>
      chat.agent({
        id: "changeset-compaction",
        compaction: {
          shouldCompact: ({ source }) => source === "outer" && compactions === 0,
          summarize: async () => {
            compactions += 1;
            return "SUMMARY-OF-EVERYTHING";
          },
        },
        run: async ({ messages, signal }) =>
          streamText({ model: recordingModel(prompts), messages, abortSignal: signal }),
      });

    const firstPrompts: unknown[] = [];
    const first = mockChatAgent(makeAgent(firstPrompts), { chatId });
    try {
      await first.sendMessage(userMessage("the early message", "u1"));
      await waitFor(() => storage.changesets.length === 1, "turn 1 save");
      expect(compactions).toBe(1);

      const state = stateOf(storage.changesets[0]!.changeset.changes);
      expect(state?.compaction).toBeDefined();
      expect(state!.compaction!.throughId).toBe(
        putIds(storage.changesets[0]!.changeset.changes).at(-1)
      );
      expect(JSON.stringify(state!.compaction!.modelMessages)).toContain("SUMMARY-OF-EVERYTHING");
      expect(JSON.stringify(state!.compaction!.modelMessages)).not.toContain("the early message");

      await first.sendMessage(userMessage("a follow-up", "u2"));
      await waitFor(() => storage.changesets.length === 2, "turn 2 save");
      expect(promptText(firstPrompts[1])).toContain("SUMMARY-OF-EVERYTHING");
      expect(promptText(firstPrompts[1])).not.toContain("the early message");
      expect(stateOf(storage.changesets[1]!.changeset.changes)?.compaction).toBeDefined();
    } finally {
      await first.close();
    }

    expect(storage.transcript(chatId)!.entries.map((e) => e.id)).toHaveLength(4);
    expect(storage.transcript(chatId)!.state).not.toBeNull();

    const secondPrompts: unknown[] = [];
    const second = mockChatAgent(makeAgent(secondPrompts), {
      chatId,
      continuation: true,
      previousRunId: "run_first",
    });
    try {
      await second.sendMessage(userMessage("after the continuation", "u3"));
      await waitFor(() => secondPrompts.length === 1, "continuation turn");

      const prompt = promptText(secondPrompts[0]);
      expect(prompt).toContain("SUMMARY-OF-EVERYTHING");
      expect(prompt).toContain("a follow-up");
      expect(prompt).toContain("after the continuation");
      expect(prompt).not.toContain("the early message");
      expect(compactions).toBe(1);
    } finally {
      await second.close();
    }
  });

  it("clears the compaction state in the same changeset as a rollback", async () => {
    const chatId = "changeset-rollback";
    let compactions = 0;
    const prompts: unknown[] = [];
    const agent = chat.agent({
      id: "changeset-rollback",
      actionSchema: z.discriminatedUnion("type", [z.object({ type: z.literal("undo") })]),
      compaction: {
        shouldCompact: ({ source }) => source === "outer" && compactions === 0,
        summarize: async () => {
          compactions += 1;
          return "SUMMARY";
        },
      },
      onAction: async ({ action }) => {
        if (action.type === "undo") chat.history.slice(0, -2);
      },
      run: async ({ messages, signal }) =>
        streamText({ model: recordingModel(prompts), messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId });
    try {
      await harness.sendMessage(userMessage("one", "u1"));
      await harness.sendMessage(userMessage("two", "u2"));
      await waitFor(() => storage.changesets.length === 2, "two turns");
      expect(stateOf(storage.changesets[1]!.changeset.changes)?.compaction).toBeDefined();

      await harness.sendAction({ type: "undo" });
      await waitFor(() => storage.changesets.length === 3, "action save");

      const { ctx, changeset } = storage.changesets[2]!;
      expect(ctx.trigger).toBe("action");
      expect(changeset.reason).toBe("action");
      expect(ops(changeset.changes)).toEqual(["truncateAfter", "state"]);
      expect(stateOf(changeset.changes)).toBeNull();
      expect(storage.transcript(chatId)!.entries.map((e) => e.id)).toHaveLength(2);
      expect(storage.transcript(chatId)!.state).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("persists conversational injections anchored to the transcript and restores them at boot", async () => {
    const chatId = "changeset-inject";
    const makeAgent = (prompts: unknown[]) =>
      chat.agent({
        id: "changeset-inject",
        onTurnComplete: async ({ turn }) => {
          if (turn === 0) {
            chat.inject([{ role: "user", content: "[note] inventory is low" } as ModelMessage]);
          }
        },
        run: async ({ messages, signal }) =>
          streamText({ model: recordingModel(prompts), messages, abortSignal: signal }),
      });

    const firstPrompts: unknown[] = [];
    const first = mockChatAgent(makeAgent(firstPrompts), { chatId });
    try {
      await first.sendMessage(userMessage("one", "u1"));
      await first.sendMessage(userMessage("two", "u2"));
      await waitFor(() => storage.changesets.length === 2, "two turns");

      expect(promptText(firstPrompts[1])).toContain("[note] inventory is low");
      const state = stateOf(storage.changesets[1]!.changeset.changes);
      expect(state?.injections).toHaveLength(1);
      expect(state!.injections![0]!.afterId).toBe("u2");
      expect(state?.queued).toBeUndefined();
      const queuedAtTurn0 = stateOf(storage.changesets[0]!.changeset.changes);
      expect(queuedAtTurn0?.queued).toHaveLength(1);
      expect(queuedAtTurn0?.injections).toBeUndefined();
    } finally {
      await first.close();
    }

    const secondPrompts: unknown[] = [];
    const second = mockChatAgent(makeAgent(secondPrompts), {
      chatId,
      continuation: true,
      previousRunId: "run_first",
    });
    try {
      await second.sendMessage(userMessage("three", "u3"));
      await waitFor(() => secondPrompts.length === 1, "continuation turn");
      const prompt = secondPrompts[0] as { role: string; content: unknown }[];
      const text = promptText(prompt);
      expect(text).toContain("[note] inventory is low");
      const noteIdx = prompt.findIndex((m) => promptText(m).includes("[note] inventory is low"));
      const u2Idx = prompt.findIndex((m) => promptText(m).includes('"two"'));
      const u3Idx = prompt.findIndex((m) => promptText(m).includes('"three"'));
      expect(noteIdx).toBeGreaterThan(u2Idx);
      expect(noteIdx).toBeLessThan(u3Idx);
    } finally {
      await second.close();
    }
  });
});

function assistantMessage(id: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text: "hello" }] };
}

describe("restoreModelLane", () => {
  it("restores a compacted lane that covers an emptied transcript", async () => {
    const summary = { role: "assistant" as const, content: "[Conversation summary] all of it" };
    const fingerprint = prefixFingerprint(createTranscriptShadow([]), "");
    const restored = await restoreModelLane(
      [userMessage("two", "u-2")],
      { v: 1, compaction: { modelMessages: [summary], throughId: "", fingerprint } },
      async (messages) => messages.map((m) => ({ role: m.role, content: m.id }) as never)
    );
    expect(restored.compacted).toBe(true);
    expect(restored.messages).toEqual([summary, { role: "user", content: "u-2" }]);
  });

  it("ignores a compacted lane whose covered prefix changed", async () => {
    const shadow = createTranscriptShadow([userMessage("one", "u-1"), assistantMessage("a-1")]);
    const state = {
      v: 1 as const,
      compaction: {
        modelMessages: [{ role: "assistant" as const, content: "summary" }],
        throughId: "a-1",
        fingerprint: prefixFingerprint(shadow, "a-1"),
      },
    };
    const edited = {
      ...assistantMessage("a-1"),
      parts: [{ type: "text" as const, text: "edited" }],
    };
    const restored = await restoreModelLane(
      [userMessage("one", "u-1"), edited, userMessage("two", "u-2")],
      state,
      async (messages) => messages.map((m) => ({ role: m.role, content: m.id }) as never)
    );
    expect(restored.compacted).toBe(false);
    expect(restored.messages.map((m) => m.content)).toEqual(["u-1", "a-1", "u-2"]);
  });
});
