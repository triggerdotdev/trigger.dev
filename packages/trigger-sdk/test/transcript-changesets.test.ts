import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { ModelMessage, UIMessage } from "ai";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { __setTranscriptStorageForTests, chat } from "../src/v3/ai.js";
import {
  memoryTranscriptStorage,
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
      expect(stateOf(storage.changesets[0]!.changeset.changes)).toBeUndefined();
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
