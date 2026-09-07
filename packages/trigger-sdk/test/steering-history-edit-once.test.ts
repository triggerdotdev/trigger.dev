import { mockChatAgent } from "../src/v3/test/index.js";

import { sessionStreams } from "@trigger.dev/core/v3";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * A `chat.history` edit after a steer has been drained.
 *
 * The edit is applied by rebuilding the model lane from the UI lane, and the
 * UI lane already holds the steer, so the rebuilt lane has it. Appending the
 * recorded model form on top of that sends it twice from the next turn on. A
 * steer-presence check passes either way; the count is what discriminates.
 */

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const userMessage = (text: string, id: string) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
async function waitFor(check: () => boolean, label = "condition", timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}
const textChunks = (text: string): LanguageModelV3StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
];
const toolCallChunks = (callId: string): LanguageModelV3StreamPart[] => [
  { type: "tool-call", toolCallId: callId, toolName: "gate", input: JSON.stringify({ q: "go" }) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: USAGE },
];
type SeqReader = { lastSeqNum: (chatId: string, dir: "in" | "out") => number | undefined };
async function sendAndLand(
  harness: { sendMessage: (m: ReturnType<typeof userMessage>) => Promise<unknown> },
  chatId: string,
  text: string,
  id: string
) {
  const seqs = sessionStreams as unknown as SeqReader;
  const before = seqs.lastSeqNum(chatId, "in") ?? -1;
  void harness.sendMessage(userMessage(text, id));
  await waitFor(() => (seqs.lastSeqNum(chatId, "in") ?? -1) > before, `append ${id}`);
}
const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

type Variant = { prepare?: boolean; compact?: boolean; deleteSteer?: boolean };

/** One steered turn with a history edit from onInjected, then a follow-up turn. Returns turn 2's prompt. */
async function runVariant(chatId: string, v: Variant): Promise<string> {
  const toolGate = deferred();
  let toolEntered = false;
  const prompts: string[] = [];
  let compacted = 0;

  const gateTool = tool({
    description: "blocks until the test opens it",
    inputSchema: z.object({ q: z.string() }),
    execute: async () => {
      toolEntered = true;
      await toolGate.promise;
      return "ok";
    },
  });

  let step = 0;
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      const isToolStep = step++ % 2 === 0;
      return {
        stream: simulateReadableStream({
          chunks: isToolStep ? toolCallChunks(`tc-${step}`) : textChunks("done"),
          initialDelayInMs: 10,
          chunkDelayInMs: 2,
        }),
      };
    },
  });

  const agent = chat.agent({
    id: chatId,
    pendingMessages: {
      shouldInject: () => true,
      ...(v.prepare
        ? {
            prepare: async ({ messages }) => [
              {
                role: "system" as const,
                content: `[OPERATOR-NOTE] ${messages.map((m) => (m.parts as { text?: string }[]).map((p) => p.text ?? "").join("")).join(" ")}`,
              },
            ],
          }
        : {}),
      onInjected: () => {
        chat.history.set(chat.history.all().filter((m) => !(v.deleteSteer && m.id === "u-2")));
      },
    },
    ...(v.compact
      ? {
          compaction: {
            shouldCompact: () => compacted === 0,
            summarize: async () => {
              compacted++;
              return "SUMMARY-OF-EVERYTHING";
            },
          },
        }
      : {}),
    run: async ({ messages, signal }) =>
      streamText({
        model,
        messages,
        abortSignal: signal,
        ...chat.toStreamTextOptions(),
        tools: { gate: gateTool },
        stopWhen: stepCountIs(5),
      }),
  });

  const harness = mockChatAgent(agent, { chatId });
  try {
    const first = harness.sendMessage(userMessage("m1", "u-1"));
    await waitFor(() => toolEntered, "tool entered");
    await sendAndLand(harness, chatId, "steer-me", "u-2");
    toolGate.resolve();
    await first;
    await waitFor(() => prompts.length >= 2, "turn 1 done");
    if (v.compact) await waitFor(() => compacted > 0, "compaction ran");
    const promptsAfterTurn1 = prompts.length;
    await harness.sendMessage(userMessage("m3", "u-3"));
    await waitFor(() => prompts.length > promptsAfterTurn1, "turn 2 prompt built");
    return prompts[promptsAfterTurn1]!;
  } finally {
    toolGate.resolve();
    await harness.close();
  }
}

describe("a history edit after a steer was drained", () => {
  it("sends the steer to later turns exactly once", { timeout: 30_000 }, async () => {
    const turn2 = await runVariant("steer-history-edit-once", {});
    expect(countOf(turn2, '"steer-me"')).toBe(1);
  });

  it("keeps the prepared form, once", { timeout: 30_000 }, async () => {
    /**
     * The rebuild converts the UI message, which is the raw form. If the raw
     * form is what stays, the model's memory of the instruction differs from
     * the one it acted on. If both stay, it is there twice.
     */
    const turn2 = await runVariant("steer-history-edit-prepared", { prepare: true });
    expect(countOf(turn2, "[OPERATOR-NOTE] steer-me")).toBe(1);
    expect(countOf(turn2, '"steer-me"')).toBe(0);
  });

  it("keeps the steer when compaction also replaces the lane", { timeout: 30_000 }, async () => {
    /**
     * A model-only compaction replaces the rebuilt lane, raw steer included.
     * If reconciliation then withholds the prepared form because the rebuild
     * "already had it", the steer is gone from the model lane altogether.
     */
    const turn2 = await runVariant("steer-history-edit-compacted", {
      prepare: true,
      compact: true,
    });
    expect(turn2).toContain("SUMMARY-OF-EVERYTHING");
    expect(countOf(turn2, "[OPERATOR-NOTE] steer-me")).toBe(1);
  });

  it("does not bring back a steer the edit removed", { timeout: 30_000 }, async () => {
    /** The edit is the app's decision. Reconciliation must not undo it. */
    const turn2 = await runVariant("steer-history-edit-deleted", {
      prepare: true,
      deleteSteer: true,
    });
    expect(turn2).not.toContain("steer-me");
  });
});
