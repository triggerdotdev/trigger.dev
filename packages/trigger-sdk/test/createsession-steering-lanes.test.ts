import { mockChatAgent } from "../src/v3/test/index.js";

import { sessionStreams } from "@trigger.dev/core/v3";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { UIMessage } from "ai";
import { chat } from "../src/v3/ai.js";

/**
 * `chat.createSession` keeps its own accumulator rather than the one
 * `chat.agent` publishes to locals, so the two lanes have to be checked on
 * this surface separately.
 *
 * The steering drain appends claimed messages to
 * `locals.get(chatCurrentUIMessagesKey)` behind a truthiness guard, and
 * `createSession` never sets that key, so the append is a silent no-op here.
 * If that is what happens, a mid-turn steer reaches the model for the answer
 * it steered and then disappears from both of the session's own lanes:
 * `turn.uiMessages`, which is what an app persists from, and `turn.messages`,
 * which is what every later turn sends to the model.
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
    {
      type: "tool-call",
      toolCallId: callId,
      toolName: "gate",
      input: JSON.stringify({ q: "go" }),
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: USAGE },
  ];
}

type SeqReader = { lastSeqNum: (chatId: string, dir: "in" | "out") => number | undefined };

/** Send and wait for the record to land on the channel, so the steer is claimable. */
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

describe("chat.createSession steering across turns", () => {
  it("keeps a mid-turn steer in both of the session's own lanes", { timeout: 30_000 }, async () => {
    const chatId = "createsession-steer-lanes";
    const toolGate = deferred();
    let toolEntered = false;

    /** Per-turn snapshots of the session's own two lanes. */
    const lanes: { turn: number; ui: string[]; model: string[] }[] = [];
    const prompts: string[][] = [];
    let turnCount = 0;

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
        prompts.push(
          prompt
            .filter((m) => m.role === "user")
            .flatMap((m) =>
              Array.isArray(m.content)
                ? (m.content as { type: string; text?: string }[])
                    .filter((c) => c.type === "text")
                    .map((c) => c.text ?? "")
                : []
            )
        );
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

    const textOf = (m: { parts?: unknown[] }) =>
      ((m.parts ?? []) as { type: string; text?: string }[])
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");

    const modelTextOf = (m: { content: unknown }) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as { type: string; text?: string }[])
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("")
          : "";

    const agent = chat.customAgent({
      id: "createsession-steer-lanes",
      run: async (payload, { signal }) => {
        const session = chat.createSession(payload, {
          signal,
          idleTimeoutInSeconds: 1,
          pendingMessages: { shouldInject: () => true },
        });

        for await (const turn of session) {
          const thisTurn = turnCount++;
          await turn.complete(
            streamText({
              model,
              messages: turn.messages,
              abortSignal: turn.signal,
              prepareStep: turn.prepareStep(),
              tools: { gate: gateTool },
              stopWhen: stepCountIs(5),
            })
          );
          lanes.push({
            turn: thisTurn,
            ui: turn.uiMessages.map(textOf),
            model: turn.messages.map(modelTextOf),
          });
        }
      },
    });

    const harness = mockChatAgent(agent, { chatId });

    try {
      const first = harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(() => toolEntered, "tool entered");
      await sendAndLand(harness, chatId, "steer-me", "u-2");
      toolGate.resolve();
      await first;

      await waitFor(() => lanes.length >= 1, "turn 1 recorded");
      const promptsAfterTurn1 = prompts.length;

      await harness.sendMessage(userMessage("m3", "u-3"));
      await waitFor(() => prompts.length > promptsAfterTurn1, "turn 2 prompt built");
      await waitFor(() => lanes.length >= 2, "turn 2 recorded");

      // The lane an app persists from.
      expect(lanes[0]!.ui).toContain("steer-me");
      // The lane every later turn sends to the model.
      expect(lanes[1]!.model).toContain("steer-me");
      // And what the model was actually asked on the later turn.
      expect(prompts[promptsAfterTurn1]!).toContain("steer-me");
    } finally {
      toolGate.resolve();
      await harness.close();
    }
  });
});

/**
 * The same lane check for a fully manual loop built on
 * `chat.MessageAccumulator`.
 *
 * This is the other accumulator-based drain site, and it files the claimed
 * messages through `this` rather than through a captured `accumulator`, so a
 * binding mistake there would not show up in the `createSession` test above.
 */
describe("chat.MessageAccumulator steering", () => {
  it("records a steer the drain consumed in both of its lanes", { timeout: 30_000 }, async () => {
    let toolEntered = false;
    const toolGate = deferred();
    const lanes: { ui: string[]; model: string[] }[] = [];
    const prompts: string[][] = [];

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
        prompts.push(
          prompt
            .filter((m) => m.role === "user")
            .flatMap((m) =>
              Array.isArray(m.content)
                ? (m.content as { type: string; text?: string }[])
                    .filter((c) => c.type === "text")
                    .map((c) => c.text ?? "")
                : []
            )
        );
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

    const textOf = (m: { parts?: unknown[] }) =>
      ((m.parts ?? []) as { type: string; text?: string }[])
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");

    const modelTextOf = (m: { content: unknown }) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as { type: string; text?: string }[])
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("")
          : "";

    const agent = chat.customAgent({
      id: "accumulator-steer-lanes",
      run: async () => {
        const conversation = new chat.MessageAccumulator({
          pendingMessages: { shouldInject: () => true },
        });
        const next = await chat.messages.waitWithIdleTimeout({
          idleTimeoutInSeconds: 60,
          timeout: "1h",
        });
        if (!next.ok) return;
        const wire = next.output as { message?: UIMessage; trigger: string };
        const messages = await conversation.addIncoming(
          wire.message ? [wire.message] : [],
          wire.trigger,
          0
        );

        const result = streamText({
          model,
          messages,
          prepareStep: conversation.prepareStep(),
          tools: { gate: gateTool },
          stopWhen: stepCountIs(5),
        });

        // Steer while the tool holds the turn open, so the drain has a step
        // boundary to consume it at.
        void (async () => {
          await waitFor(() => toolEntered, "tool entered");
          await conversation.steerAsync(userMessage("steer-me", "u-2"));
          toolGate.resolve();
        })();

        const captured = await chat.pipeAndCapture(result);
        if (captured.message) await conversation.addResponse(captured.message);
        lanes.push({
          ui: conversation.uiMessages.map(textOf),
          model: conversation.modelMessages.map(modelTextOf),
        });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "accumulator-steer-lanes" });
    try {
      await harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(() => lanes.length >= 1, "turn recorded");

      // The drain put it in the prompt, which is what makes the lane checks meaningful.
      expect(prompts.some((p) => p.includes("steer-me"))).toBe(true);
      expect(lanes[0]!.ui).toContain("steer-me");
      expect(lanes[0]!.model).toContain("steer-me");
    } finally {
      toolGate.resolve();
      await harness.close();
    }
  });
});
