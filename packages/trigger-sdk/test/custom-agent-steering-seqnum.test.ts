import { mockChatAgent } from "../src/v3/test/index.js";

import { sessionStreams } from "@trigger.dev/core/v3";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * The validating steering observer parses a frame before handing it to the
 * steering queue, so the handler runs after an await. With two frames in
 * flight, anything that tracks "the current sequence" outside the handler
 * already holds the newer frame's number by the time the older frame's parse
 * resolves, and the queue entry is built against the wrong record.
 *
 * That matters because `drainSteeringQueue` takes the record by `seqNum`. An
 * entry carrying the wrong one removes a message nobody answered, and leaves
 * the injected message's own record on the channel where a later turn answers
 * it a second time.
 *
 * The scenario below therefore needs two frames observed before either parse
 * resolves, which the gated async schema guarantees without depending on
 * timing: mid-turn frames block on `parseGate`, while the boot frame
 * (`sequence` 0) passes straight through so the run can start. Turn 1 takes two
 * steps so it has a `prepareStep` boundary to inject at, held open by a tool
 * gate; later turns answer in one step.
 *
 * The whole batch is injected, so the fix shows up twice over: with a shared
 * sequence both entries carry the newer one, the first `take` consumes the
 * second frame's record and the second `take` finds nothing, so only one
 * message is injected, the other is lost outright, and the injected message's
 * own record survives to be answered again as a second turn.
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

function gatedTwoStepModel(answers: string[]) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const isFirstTurnToolStep = call++ === 0;
      const text = `ANSWER(${lastUserText(prompt)})`;
      if (!isFirstTurnToolStep) answers.push(text);
      return {
        stream: simulateReadableStream({
          chunks: isFirstTurnToolStep ? toolCallChunks("tc-1") : textChunks(text),
          initialDelayInMs: 10,
          chunkDelayInMs: 2,
        }),
      };
    },
  });
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

describe("chat.customAgent steering under async client-data validation", () => {
  it(
    "takes the record it injected, so the declined message still gets its own turn",
    { timeout: 30_000 },
    async () => {
      const chatId = "steering-seqnum-chat";
      const clientData = { sequence: 0 };
      const parseGate = deferred();
      const toolGate = deferred();
      const answers: string[] = [];
      const injected: string[] = [];
      const received: string[] = [];
      let toolEntered = false;
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

      const model = gatedTwoStepModel(answers);

      const agent = chat
        .withClientData({
          schema: async (value: unknown) => {
            const sequence = (value as { sequence: number }).sequence;
            if (sequence > 0) await parseGate.promise;
            return { sequence };
          },
        })
        .customAgent({
          id: "custom-agent-steering-seqnum",
          run: async (payload, { signal }) => {
            const session = chat.createSession(payload, {
              signal,
              idleTimeoutInSeconds: 1,
              pendingMessages: {
                shouldInject: () => true,
                onReceived: ({ message }) => {
                  received.push(message.id);
                },
                onInjected: ({ messages }) => {
                  injected.push(...messages.map((m) => m.id));
                },
              },
            });

            for await (const turn of session) {
              turnCount++;
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
            }
          },
        });

      const harness = mockChatAgent(agent, { chatId, clientData });

      try {
        const opening = harness.sendMessage(userMessage("opening", "m-0"));
        void opening.catch(() => {});
        await waitFor(() => turnCount === 1, "turn 1 started");
        await waitFor(() => toolEntered, "tool entered, boundary pending");

        clientData.sequence = 1;
        await sendAndLand(harness, chatId, "first", "m-a");
        clientData.sequence = 2;
        await sendAndLand(harness, chatId, "second", "m-b");

        parseGate.resolve();
        await waitFor(
          () => received.includes("m-a") && received.includes("m-b"),
          "both frames validated and queued"
        );

        toolGate.resolve();
        await waitFor(
          () => injected.includes("m-a") && injected.includes("m-b"),
          "both frames injected"
        );

        await opening;

        expect(injected).toEqual(["m-a", "m-b"]);
        expect(turnCount).toBe(1);
        expect(answers).toHaveLength(1);
      } finally {
        parseGate.resolve();
        toolGate.resolve();
        await harness.close();
      }
    }
  );
});
