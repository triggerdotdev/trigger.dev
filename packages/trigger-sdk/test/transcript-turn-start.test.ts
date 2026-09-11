import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setTranscriptStorageForTests, chat } from "../src/v3/ai.js";
import {
  memoryTranscriptStorage,
  type MemoryTranscriptStorage,
  type TranscriptChange,
  type TranscriptStorage,
} from "../src/v3/transcriptStorage.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function userMessage(text: string, id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release: () => release() };
}

function gatedModel(gates: { promise: Promise<void> }[], onCall: () => void, id = "t1") {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const opened = gates[Math.min(call, gates.length - 1)]!;
      call++;
      onCall();
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          async start(controller) {
            controller.enqueue({ type: "text-start", id });
            controller.enqueue({ type: "text-delta", id, delta: "answering" });
            await opened.promise;
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage,
            });
            controller.close();
          },
        }),
      };
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

const putIds = (changes: TranscriptChange[]) =>
  changes.flatMap((c) => (c.op === "put" ? [c.message.id] : []));

let storage: MemoryTranscriptStorage;

beforeEach(() => {
  storage = memoryTranscriptStorage();
  __setTranscriptStorageForTests(storage);
});

afterEach(() => {
  __setTranscriptStorageForTests(undefined);
});

describe("chat.agent turn-start transcript save", () => {
  it("persists the incoming user message before the answer finishes", async () => {
    const chatId = "turn-start-mid-answer";
    const firstTurn = gate();
    const secondTurn = gate();
    const calls: number[] = [];
    const model = gatedModel([firstTurn, secondTurn], () => calls.push(1));
    const agent = chat.agent({
      id: chatId,
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId });

    try {
      firstTurn.release();
      await harness.sendMessage(userMessage("hello", "u1"));
      await waitFor(
        () => storage.changesets.some((c) => c.changeset.reason === "turn-complete"),
        "turn 1 complete"
      );

      const sent = harness.sendMessage(userMessage("what is 2+2?", "u2"));
      await waitFor(() => calls.length === 2, "turn 2 started");

      await waitFor(
        () => (storage.transcript(chatId)?.entries ?? []).some((e) => e.id === "u2"),
        "the message being answered is durable while the answer streams"
      );

      expect(storage.changesets.filter((c) => c.changeset.reason === "turn-complete")).toHaveLength(
        1
      );
      const midTurn = storage.changesets.at(-1)!;
      expect(midTurn.changeset.reason).toBe("turn-start");
      expect(putIds(midTurn.changeset.changes)).toContain("u2");

      secondTurn.release();
      await sent;
      await waitFor(
        () => storage.changesets.some((c) => c.changeset.reason === "turn-complete"),
        "turn 2 completed"
      );
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("leaves both cursors on the previous turn's position", async () => {
    const chatId = "turn-start-cursors";
    const open = gate();
    open.release();

    const calls: number[] = [];
    const model = gatedModel([open], () => calls.push(1));
    const agent = chat.agent({
      id: chatId,
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId });

    try {
      await harness.sendMessage(userMessage("hello", "u1"));
      await waitFor(
        () => storage.changesets.some((c) => c.changeset.reason === "turn-complete"),
        "turn 1 complete"
      );
      const afterTurnOne = storage.changesets.at(-1)!.changeset.cursors;

      await harness.sendMessage(userMessage("again", "u2"));
      await waitFor(
        () =>
          storage.changesets.some((c) => c.changeset.reason === "turn-start" && c.ctx.turn === 1),
        "turn 2 turn-start save"
      );

      const turnStart = storage.changesets.find(
        (c) => c.changeset.reason === "turn-start" && c.ctx.turn === 1
      )!;
      expect(putIds(turnStart.changeset.changes)).toContain("u2");
      expect(turnStart.changeset.cursors?.lastOutEventId).toBe(afterTurnOne?.lastOutEventId);
      expect(turnStart.changeset.cursors?.lastInEventId).toBe(afterTurnOne?.lastInEventId);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("pays the gate timeout once per turn, not once per write", async () => {
    const chatId = "turn-start-timeout-latch";
    const open = gate();
    open.release();
    const model = gatedModel([open], () => {});
    const agent = chat.agent({
      id: chatId,
      onTurnStart: async () => {
        chat.deferBeforeOutput(new Promise<void>(() => {}));
      },
      run: async ({ messages, signal }) => {
        for (let i = 0; i < 3; i++) {
          await chat.stream.append({
            type: "data-progress",
            data: { step: i },
            transient: true,
          } as never);
        }
        return streamText({ model, messages, abortSignal: signal });
      },
    });
    const harness = mockChatAgent(agent, { chatId });

    try {
      const started = Date.now();
      await harness.sendMessage(userMessage("hello", "u1"));
      const elapsed = Date.now() - started;
      console.log(`TIMEOUT_LATCH elapsed=${elapsed}ms chunks=${harness.allRawChunks.length}`);

      expect(harness.allRawChunks.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(19_000);
    } finally {
      await harness.close();
    }
  }, 90_000);

  it("wakes overlapping output waiters when the turn fails open", async () => {
    const chatId = "turn-start-shared-failopen";
    const open = gate();
    open.release();
    const model = gatedModel([open], () => {});
    const agent = chat.agent({
      id: chatId,
      onTurnStart: async () => {
        chat.deferBeforeOutput(new Promise<void>(() => {}));
      },
      run: async ({ messages, signal }) => {
        const early = chat.stream.append({
          type: "data-progress",
          data: { step: 0 },
          transient: true,
        } as never);
        await new Promise((r) => setTimeout(r, 6_000));
        const late = chat.stream.append({
          type: "data-progress",
          data: { step: 1 },
          transient: true,
        } as never);
        await Promise.all([early, late]);
        return streamText({ model, messages, abortSignal: signal });
      },
    });
    const harness = mockChatAgent(agent, { chatId });

    try {
      const started = Date.now();
      await harness.sendMessage(userMessage("hello", "u1"));
      const elapsed = Date.now() - started;
      console.log(`SHARED_FAILOPEN elapsed=${elapsed}ms`);

      expect(harness.allRawChunks.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(13_000);
    } finally {
      await harness.close();
    }
  }, 90_000);

  it("holds session.out until the turn-start save lands", async () => {
    const chatId = "turn-start-gates-out";
    const slow = gate();
    let sawChunkBeforeSave = false;
    let saveResolved = false;

    const slowStorage: TranscriptStorage<unknown> = {
      async load(scope, opts) {
        return storage.load(scope, opts);
      },
      async save(ctx, changeset) {
        if (changeset.reason === "turn-start") {
          await slow.promise;
          saveResolved = true;
        }
        return storage.save(ctx, changeset);
      },
    };
    __setTranscriptStorageForTests(slowStorage);

    const open = gate();
    open.release();
    const calls: number[] = [];
    const model = gatedModel([open], () => calls.push(1));
    const agent = chat.agent({
      id: chatId,
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId });

    try {
      const sent = harness.sendMessage(userMessage("hello", "u1"));
      await waitFor(() => calls.length === 1, "model ran");
      await new Promise((r) => setTimeout(r, 300));

      const chunksDuringHold = harness.allRawChunks.length;
      if (chunksDuringHold > 0 && !saveResolved) sawChunkBeforeSave = true;

      slow.release();
      await sent;

      expect(saveResolved).toBe(true);
      expect(chunksDuringHold).toBe(0);
      expect(sawChunkBeforeSave).toBe(false);
      expect(harness.allRawChunks.length).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
