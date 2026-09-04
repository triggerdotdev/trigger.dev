import { mockChatAgent } from "../src/v3/test/index.js";

import { sessionStreams } from "@trigger.dev/core/v3";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * A turn that drains a steering message and then fails.
 *
 * The error path builds its own `newUIMessages` from the wire message and the
 * partial response, so a steer the drain consumed is not in it. That is the
 * same append-only persistence hole the steering fix exists to close: the app
 * stores what `onTurnComplete` hands it, the failed turn hands it everything
 * except the steer, and the instruction is gone.
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

function toolCallChunks(callId: string): LanguageModelV3StreamPart[] {
  return [
    { type: "tool-call", toolCallId: callId, toolName: "gate", input: JSON.stringify({ q: "go" }) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: USAGE },
  ];
}

/**
 * Emits a partial then errors, one chunk per pull so the queue isn't reset by
 * erroring in the same tick as the enqueue.
 */
function erroringStream(): ReadableStream<LanguageModelV3StreamPart> {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "partial" },
  ];
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]!);
        return;
      }
      controller.error(new Error("UND_ERR_BODY_TIMEOUT"));
    },
  });
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

describe("chat.agent steering on a turn that fails", () => {
  it("still reports the steer in the error path's newUIMessages", async () => {
    const chatId = "steer-error-path";
    const toolGate = deferred();
    let toolEntered = false;
    const events: {
      newUIMessages: UIMessage[];
      messages: unknown[];
      newMessages: unknown[];
      finishReason?: string;
    }[] = [];
    const promptsSawSteer: boolean[] = [];

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
        promptsSawSteer.push(JSON.stringify(prompt).includes("steer-me"));
        // Step 1 calls the tool, step 2 fails mid-stream, the next turn answers.
        const n = step++;
        const fromChunks = (chunks: LanguageModelV3StreamPart[]) => ({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
              for (const ch of chunks) c.enqueue(ch);
              c.close();
            },
          }),
        });
        if (n === 0) return fromChunks(toolCallChunks("tc-1"));
        if (n === 1) return { stream: erroringStream() };
        return fromChunks([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "ok" },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
        ]);
      },
    });

    const agent = chat.agent({
      id: "steer-error-path",
      pendingMessages: {
        shouldInject: () => true,
        prepare: async ({ messages }) => [
          {
            role: "system",
            content: `[OPERATOR-NOTE] ${messages
              .map((m) => (m.parts as { text?: string }[]).map((p) => p.text ?? "").join(""))
              .join(" ")}`,
          },
        ],
      },
      onTurnComplete: async ({ newUIMessages, messages, newMessages, finishReason }) => {
        events.push({
          newUIMessages: [...(newUIMessages ?? [])],
          messages: [...messages],
          newMessages: [...(newMessages ?? [])],
          finishReason,
        });
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
      void harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(() => toolEntered, "tool entered");
      await sendAndLand(harness, chatId, "steer-me", "u-2");
      toolGate.resolve();

      await waitFor(() => events.length >= 1, "turn complete fired");

      // The turn really did fail, and the steer really did reach the model,
      // so the lane check below is about persistence and nothing else.
      expect(events[0]!.finishReason).toBe("error");
      expect(promptsSawSteer.some(Boolean)).toBe(true);

      const texts = events[0]!.newUIMessages.flatMap((m) =>
        ((m.parts ?? []) as { type: string; text?: string }[])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
      );
      expect(texts).toContain("steer-me");

      // The model lane the failed turn reports has to carry it too, and so
      // does the prompt the next turn actually sends. Reconciling only on the
      // success path leaves it pending, so the next turn misses it and it
      // lands a slot late at the end of that turn.
      expect(JSON.stringify(events[0]!.messages)).toContain("[OPERATOR-NOTE] steer-me");
      // The per-turn delta carries the same form, not a reconversion of the UI
      // message: append-only model persistence from `newMessages` would
      // otherwise store a different instruction from the one the model acted on.
      expect(JSON.stringify(events[0]!.newMessages)).toContain("[OPERATOR-NOTE] steer-me");
      const promptsBefore = promptsSawSteer.length;
      await harness.sendMessage(userMessage("m3", "u-3"));
      await waitFor(() => promptsSawSteer.length > promptsBefore, "turn 2 prompt built");
      expect(promptsSawSteer[promptsBefore]).toBe(true);
    } finally {
      toolGate.resolve();
      await harness.close();
    }
  });
});
