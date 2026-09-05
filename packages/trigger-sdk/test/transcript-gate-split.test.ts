import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setTranscriptStorageForTests, chat } from "../src/v3/ai.js";
import {
  memoryTranscriptStorage,
  type MemoryTranscriptStorage,
  type TranscriptStorage,
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

function recordingModel(prompts: unknown[]) {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      return { stream: simulateReadableStream({ chunks: textChunks("ack") }) };
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

let storage: MemoryTranscriptStorage;

beforeEach(() => {
  storage = memoryTranscriptStorage();
  __setTranscriptStorageForTests(storage);
});

afterEach(() => {
  __setTranscriptStorageForTests(undefined);
  vi.restoreAllMocks();
});

describe("the persistence gate split", () => {
  it("fires onRecoveryBoot for a hydrateMessages agent when a partial assistant is in the tail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const recoveryEvents: { partialAssistant?: UIMessage }[] = [];
    const onRecoveryBoot = async (event: { partialAssistant?: UIMessage }) => {
      recoveryEvents.push(event);
      return {};
    };
    const hydrated: UIMessage[] = [
      userMessage("from my database", "db-u1"),
      { id: "db-a1", role: "assistant", parts: [{ type: "text", text: "stored answer" }] },
    ];
    const hydrateCalls: { previousMessages: UIMessage[] }[] = [];
    const prompts: unknown[] = [];
    const agent = chat.agent({
      id: "gate-split-hydrate-recovery",
      onRecoveryBoot,
      hydrateMessages: async ({ previousMessages, incomingMessages }) => {
        hydrateCalls.push({ previousMessages });
        return [...hydrated, ...incomingMessages];
      },
      run: async ({ messages, signal }) =>
        streamText({ model: recordingModel(prompts), messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "gate-split-hydrate-recovery",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionOutPartial({
      id: "a-orphan",
      role: "assistant",
      parts: [{ type: "text", text: "half an ans" }],
    });
    try {
      await harness.sendMessage(userMessage("next", "u2"));
      await waitFor(() => prompts.length === 1, "turn");

      expect(recoveryEvents).toHaveLength(1);
      expect(recoveryEvents[0]!.partialAssistant?.id).toBe("a-orphan");

      expect(hydrateCalls).toHaveLength(1);
      expect(JSON.stringify(prompts[0])).toContain("from my database");
      expect(storage.changesets).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("uses the storage's loadContext for the model's context and still saves the transcript", async () => {
    const contextCalls: { trigger: string; previousMessages: UIMessage[] }[] = [];
    const loadContext = async (
      _scope: unknown,
      event: { trigger: string; previousMessages: UIMessage[]; incomingMessages: UIMessage[] }
    ) => {
      contextCalls.push({ trigger: event.trigger, previousMessages: event.previousMessages });
      return [userMessage("only what the app chose", "ctx-u1"), ...event.incomingMessages];
    };
    const withContext: TranscriptStorage<unknown> = {
      load: storage.load.bind(storage),
      save: storage.save.bind(storage),
      loadContext: loadContext as TranscriptStorage<unknown>["loadContext"],
    };
    __setTranscriptStorageForTests(withContext);

    const prompts: unknown[] = [];
    const agent = chat.agent({
      id: "gate-split-load-context",
      run: async ({ messages, signal }) =>
        streamText({ model: recordingModel(prompts), messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "gate-split-load-context" });
    try {
      await harness.sendMessage(userMessage("first", "u1"));
      await waitFor(() => storage.changesets.length === 1, "save");

      expect(contextCalls).toHaveLength(1);
      expect(contextCalls[0]!.trigger).toBe("submit-message");
      const prompt = JSON.stringify(prompts[0]);
      expect(prompt).toContain("only what the app chose");
      expect(prompt).toContain('"first"');

      const ids = storage.changesets[0]!.changeset.changes.flatMap((c) =>
        c.op === "put" ? [c.message.id] : []
      );
      expect(ids).toEqual(["ctx-u1", "u1", expect.any(String)]);
    } finally {
      await harness.close();
    }
  });

  it("refuses an agent that sets both hydrateMessages and a storage with loadContext", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    __setTranscriptStorageForTests({
      load: storage.load.bind(storage),
      save: storage.save.bind(storage),
      loadContext: async () => [],
    });
    expect(() =>
      chat.agent({
        id: "gate-split-both",
        hydrateMessages: async () => [],
        run: async ({ messages, signal }) =>
          streamText({ model: recordingModel([]), messages, abortSignal: signal }),
      })
    ).toThrow(/hydrateMessages/);
  });

  it("warns once that hydrateMessages is deprecated", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    chat.agent({
      id: "gate-split-deprecated",
      hydrateMessages: async () => [],
      run: async ({ messages, signal }) =>
        streamText({ model: recordingModel([]), messages, abortSignal: signal }),
    });
    const deprecations = warn.mock.calls.filter((c) => String(c[0]).includes("hydrateMessages"));
    expect(deprecations).toHaveLength(1);
    expect(String(deprecations[0]![0])).toMatch(/deprecated/);
  });
});
