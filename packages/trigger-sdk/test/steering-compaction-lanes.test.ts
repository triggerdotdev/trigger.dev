import { mockChatAgent } from "../src/v3/test/index.js";

import { sessionStreams } from "@trigger.dev/core/v3";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertToModelMessages, simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * Steering and compaction in the same turn.
 *
 * Compaction is model-only by design: it replaces the model messages with a
 * summary and deliberately leaves the UI messages whole, so the chat still
 * displays the full conversation. Reconciling the model lane by rebuilding it
 * from the UI lane therefore un-compacts it, and the next turn is sent the
 * entire pre-compaction transcript.
 *
 * The assertion that catches this is the absence of an early message, not the
 * presence of the steer: a rebuild puts the steer in the prompt too, so a
 * steer-presence check passes while compaction has been silently undone.
 */

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function userMessage(text: string, id: string) {
  return { id, role: "user" as const, parts: [{ type: "text" as const, text }] };
}

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

function textChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
}

function toolCallChunks(callId: string): LanguageModelV3StreamPart[] {
  return [
    { type: "tool-call", toolCallId: callId, toolName: "gate", input: JSON.stringify({ q: "go" }) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: USAGE },
  ];
}

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

const flatUserTexts = (prompt: { role: string; content: unknown }[]) =>
  prompt
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as { type: string; text?: string }[])
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
        : []
    );

describe("chat.agent steering with compaction in the same turn", () => {
  it("keeps the summary and adds the steer, rather than restoring the transcript", async () => {
    const chatId = "steer-compaction";
    const toolGate = deferred();
    let toolEntered = false;
    const prompts: string[][] = [];
    const allPrompts: string[] = [];

    const gateTool = tool({
      description: "blocks until the test opens it",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => {
        toolEntered = true;
        await toolGate.promise;
        return "COMPACTED_TOOL_SENTINEL";
      },
    });

    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(flatUserTexts(prompt));
        allPrompts.push(JSON.stringify(prompt));
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

    const completedTurns: { messages: string; newMessages: string; fullDelta: string }[] = [];
    let compacted = 0;
    const agent = chat.agent({
      id: "steer-compaction",
      pendingMessages: { shouldInject: () => true },
      onTurnComplete: async ({ messages, newMessages, newUIMessages }) => {
        completedTurns.push({
          messages: JSON.stringify(messages),
          newMessages: JSON.stringify(newMessages),
          fullDelta: JSON.stringify(await convertToModelMessages(newUIMessages)),
        });
      },
      compaction: {
        // Compact once, at the first step boundary of turn 1.
        shouldCompact: () => compacted === 0,
        summarize: async () => {
          compacted++;
          return "SUMMARY-OF-EVERYTHING";
        },
      },
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
      const first = harness.sendMessage(userMessage("EARLY-SENTINEL", "u-1"));
      await waitFor(() => toolEntered, "tool entered");
      await sendAndLand(harness, chatId, "steer-me", "u-2");
      toolGate.resolve();
      await first;

      await waitFor(() => compacted > 0, "compaction ran");
      const promptsAfterTurn1 = prompts.length;

      await harness.sendMessage(userMessage("m3", "u-3"));
      await waitFor(() => prompts.length > promptsAfterTurn1, "turn 2 prompt built");

      const turn2 = prompts[promptsAfterTurn1]!;
      const turn2Raw = allPrompts[promptsAfterTurn1]!;

      // The steer has to survive.
      expect(turn2).toContain("steer-me");
      // And so does the compaction: the summary is what the model gets...
      expect(turn2Raw).toContain("SUMMARY-OF-EVERYTHING");
      // ...instead of the message the summary replaced. This is the assertion a
      // rebuild-based reconciliation fails.
      expect(turn2).not.toContain("EARLY-SENTINEL");
      // The current turn's tool response was summarized too. Keeping the old
      // user message out is insufficient if completion re-appends every step.
      expect(allPrompts[1]).not.toContain("COMPACTED_TOOL_SENTINEL");
      expect(turn2Raw).not.toContain("COMPACTED_TOOL_SENTINEL");
      expect(turn2Raw).not.toContain('"toolCallId":"tc-1"');

      // Append-only history consumers still receive the complete turn delta.
      expect(completedTurns[0]?.messages).not.toContain("COMPACTED_TOOL_SENTINEL");
      expect(completedTurns[0]?.newMessages).toContain("COMPACTED_TOOL_SENTINEL");
      expect(completedTurns[0]?.newMessages).toContain('"toolCallId":"tc-1"');
      expect(completedTurns[0]?.newMessages).toContain("done");
      // UI storage keeps one assistant; model deltas split it at the durable
      // injection marker. The same content now has its actual causal order.
      const delta = JSON.parse(completedTurns[0]!.newMessages);
      expect(delta.map((m: { role: string }) => m.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "user",
        "assistant",
      ]);
      expect(delta).toHaveLength(JSON.parse(completedTurns[0]!.fullDelta).length);
      expect(JSON.stringify(delta[3])).toContain("steer-me");
    } finally {
      toolGate.resolve();
      await harness.close();
    }
  });
});
