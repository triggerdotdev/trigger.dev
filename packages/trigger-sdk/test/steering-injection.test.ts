import { mockChatAgent } from "../src/v3/test/index.js";

import { sessionStreams } from "@trigger.dev/core/v3";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * A `prepareStep` boundary, which is where pending messages are injected, only
 * exists on a turn that takes more than one step. Nothing else in this package
 * produced one, so injection had no unit coverage at all: every steering test
 * asserted arrival and none could reach the drain.
 *
 * `twoStepModel` gives a turn a real boundary. Step one calls a tool, the tool
 * blocks on a gate the test controls, and step two answers. Holding the tool
 * open is what makes the boundary deterministic: a message appended while the
 * gate is shut is guaranteed to be queued before `prepareStep` runs, with no
 * reliance on stream timing.
 */

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function userMessage(text: string, id: string) {
  return { id, role: "user" as const, parts: [{ type: "text" as const, text }] };
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
    { type: "tool-input-start", id: callId, toolName: "gate" },
    { type: "tool-input-delta", id: callId, delta: JSON.stringify({ q: "x" }) },
    { type: "tool-input-end", id: callId },
    { type: "tool-call", toolCallId: callId, toolName: "gate", input: JSON.stringify({ q: "x" }) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE },
  ];
}

function lastUserText(prompt: { role: string; content: unknown }[]): string {
  const users = prompt.filter((m) => m.role === "user");
  const last = users[users.length - 1];
  return Array.isArray(last?.content)
    ? (last.content as { type: string; text?: string }[])
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("")
    : "";
}

/** Emits a tool call on each turn's first step, then answers on the second. */
function twoStepModel() {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const isToolStep = step++ % 2 === 0;
      return {
        stream: simulateReadableStream({
          chunks: isToolStep
            ? toolCallChunks(`tc-${step}`)
            : textChunks(`ANSWER(${lastUserText(prompt)})`),
          initialDelayInMs: 10,
          chunkDelayInMs: 2,
        }),
      };
    },
  });
}

function makeGate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function streamedText(harness: { allChunks: unknown[] }): string {
  return (harness.allChunks as { type?: string; delta?: string }[])
    .filter((c) => c.type === "text-delta")
    .map((c) => c.delta ?? "")
    .join("");
}

function injectedChunks(harness: { allRawChunks: unknown[] }) {
  return (harness.allRawChunks as { type?: string; data?: { messageIds?: string[] } }[]).filter(
    (c) => c.type === "data-pending-message-injected"
  );
}

function injectedIds(harness: { allRawChunks: unknown[] }): string[] {
  return injectedChunks(harness).flatMap((c) => c.data?.messageIds ?? []);
}

function turnCompleteCount(harness: { allRawChunks: unknown[] }): number {
  return (harness.allRawChunks as { type?: string }[]).filter(
    (c) => c.type === "trigger:turn-complete"
  ).length;
}

async function waitFor(check: () => boolean, label = "condition", timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

type SeqReader = { lastSeqNum(sessionId: string, io: "in" | "out"): number | undefined };

/** Appends a message and resolves once the channel has actually taken it. */
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

describe("chat.agent injection at a prepareStep boundary", () => {
  it(
    "injects a message that arrived mid-turn and does not answer it again",
    { timeout: 30_000 },
    async () => {
      const chatId = "inject-basic";
      const gate = makeGate();
      let toolEntered = false;
      const injectedBatches: string[][] = [];

      const gateTool = tool({
        description: "blocks until the test opens it",
        inputSchema: z.object({ q: z.string() }),
        execute: async () => {
          toolEntered = true;
          await gate.promise;
          return "ok";
        },
      });

      const agent = chat.agent({
        id: "steering-injection.basic",
        pendingMessages: {
          shouldInject: () => true,
          onInjected: ({ messages }) => {
            injectedBatches.push(messages.map((m) => m.id));
          },
        },
        run: async ({ messages, signal }) =>
          streamText({
            model: twoStepModel(),
            messages,
            abortSignal: signal,
            // Spread first so the prepareStep it supplies survives and nothing
            // below is clobbered by it.
            ...chat.toStreamTextOptions(),
            tools: { gate: gateTool },
            stopWhen: stepCountIs(5),
          }),
      });

      const harness = mockChatAgent(agent, { chatId });
      try {
        const first = harness.sendMessage(userMessage("m1", "u-1"));
        await waitFor(() => toolEntered, "tool entered");

        await sendAndLand(harness, chatId, "m2", "u-2");
        gate.open();
        await first;

        await waitFor(() => injectedBatches.length > 0, "onInjected fired");

        expect(injectedBatches[0]).toEqual(["u-2"]);
        expect(injectedIds(harness)).toContain("u-2");
        // Answered inside turn 1, which is what injection means.
        expect(streamedText(harness)).toContain("ANSWER(m2)");

        // And consumed by it, so it must not also get a turn of its own. A
        // second turn-complete would mean the record was left on the channel.
        await new Promise((r) => setTimeout(r, 400));
        expect(turnCompleteCount(harness)).toBe(1);
      } finally {
        gate.open();
        await harness.close();
      }
    }
  );
});

describe("chat.agent injection claims only its own batch", () => {
  /**
   * `shouldInject` and `prepare` can await, so a record can arrive after the
   * batch was assembled. The callbacks never saw it and could not have injected
   * it, so consuming it with the batch would lose a message that should have
   * become a later turn.
   */
  it(
    "leaves a message that arrived after the batch was assembled",
    { timeout: 30_000 },
    async () => {
      const chatId = "inject-late-arrival";
      const toolGate = makeGate();
      const injectGate = makeGate();
      let toolEntered = false;
      let injectAsked = false;
      const injectedBatches: string[][] = [];

      const gateTool = tool({
        description: "blocks until the test opens it",
        inputSchema: z.object({ q: z.string() }),
        execute: async () => {
          toolEntered = true;
          await toolGate.promise;
          return "ok";
        },
      });

      const agent = chat.agent({
        id: "steering-injection.late-arrival",
        pendingMessages: {
          shouldInject: async () => {
            injectAsked = true;
            await injectGate.promise;
            return true;
          },
          onInjected: ({ messages }) => {
            injectedBatches.push(messages.map((m) => m.id));
          },
        },
        run: async ({ messages, signal }) =>
          streamText({
            model: twoStepModel(),
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

        // m2 is the batch: queued before the boundary, so the callback sees it.
        await sendAndLand(harness, chatId, "m2", "u-2");
        toolGate.open();
        await waitFor(() => injectAsked, "shouldInject called");

        // m3 lands while the callback is parked, so it is not in the batch.
        await sendAndLand(harness, chatId, "m3", "u-3");
        injectGate.open();
        await first;

        await waitFor(() => injectedBatches.length > 0, "onInjected fired");
        expect(injectedBatches.flat()).toEqual(["u-2"]);
        expect(injectedIds(harness)).not.toContain("u-3");

        /**
         * The discriminator. Without the snapshot, m3 is swept into the same
         * drain: its model messages reach the model, so `ANSWER(m3)` still
         * appears, but inside turn 1 and without being reported as injected.
         * Asserting on the text alone therefore passes on the bug. A second
         * turn-complete is what distinguishes "m3 got its own turn" from "m3
         * was silently consumed by turn 1".
         */
        await waitFor(() => turnCompleteCount(harness) >= 2, "m3 got its own turn");
        expect(streamedText(harness)).toContain("ANSWER(m3)");
      } finally {
        toolGate.open();
        injectGate.open();
        await harness.close();
      }
    }
  );

  /**
   * `prepare` is caller code. Claiming happens before it runs, so a throw would
   * consume the messages and leave them unanswered unless the claim is returned.
   */
  it("gives the claim back when prepare throws", { timeout: 30_000 }, async () => {
    const chatId = "inject-prepare-throws";
    const toolGate = makeGate();
    let toolEntered = false;
    let prepareCalls = 0;

    const gateTool = tool({
      description: "blocks until the test opens it",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => {
        toolEntered = true;
        await toolGate.promise;
        return "ok";
      },
    });

    const agent = chat.agent({
      id: "steering-injection.prepare-throws",
      pendingMessages: {
        shouldInject: () => true,
        prepare: () => {
          prepareCalls++;
          throw new Error("synthetic prepare failure");
        },
      },
      run: async ({ messages, signal }) =>
        streamText({
          model: twoStepModel(),
          messages,
          abortSignal: signal,
          ...chat.toStreamTextOptions(),
          tools: { gate: gateTool },
          stopWhen: stepCountIs(5),
        }),
    });

    const harness = mockChatAgent(agent, { chatId });
    try {
      const first = harness.sendMessage(userMessage("m1", "u-1")).catch(() => undefined);
      await waitFor(() => toolEntered, "tool entered");

      await sendAndLand(harness, chatId, "m2", "u-2");
      toolGate.open();
      await first;

      await waitFor(() => prepareCalls > 0, "prepare called");
      // Nothing was injected, and the message must not have been eaten by the
      // failed transform: it is still owed and gets answered by a later turn.
      expect(injectedIds(harness)).not.toContain("u-2");
      await waitFor(() => streamedText(harness).includes("ANSWER(m2)"), "m2 answered later");
    } finally {
      toolGate.open();
      await harness.close();
    }
  });
});

/**
 * Whether an injected message survives into the next turn's model context.
 *
 * The UI accumulator and the model accumulator are maintained separately, and
 * a drained message used to reach only the first: the browser, the snapshot
 * and `chat.history.*` all showed it while every later turn of the run
 * answered without it. The model lane is now rebuilt from the UI lane at the
 * end of a turn that drained, and this is the repro for it.
 */
describe("chat.agent injected message in the next turn's context", () => {
  it(
    "carries an injected message into the following turn's prompt",
    { timeout: 30_000 },
    async () => {
      const chatId = "inject-next-turn";
      const toolGate = makeGate();
      let toolEntered = false;
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
      const recordingModel = new MockLanguageModelV3({
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

      const agent = chat.agent({
        id: "steering-injection.next-turn",
        pendingMessages: { shouldInject: () => true },
        run: async ({ messages, signal }) =>
          streamText({
            model: recordingModel,
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
        toolGate.open();
        await first;

        await waitFor(() => turnCompleteCount(harness) >= 1, "turn 1 complete");
        const promptsAfterTurn1 = prompts.length;

        // A fresh turn. Its prompt is built from accumulated history, so it
        // should still contain the message that was injected into turn 1.
        await harness.sendMessage(userMessage("m3", "u-3"));
        await waitFor(() => prompts.length > promptsAfterTurn1, "turn 2 prompt built");

        const turn2Prompt = prompts[promptsAfterTurn1]!;
        expect(turn2Prompt).toContain("steer-me");
      } finally {
        toolGate.open();
        await harness.close();
      }
    }
  );
});
