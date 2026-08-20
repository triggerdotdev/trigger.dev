// Import the test harness FIRST — installs the resource catalog so
// `chat.agent()` below registers its task functions correctly.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import type { UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function userMessage(text: string, id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function textOf(message: UIMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * Two steps with a tool call in between, so there is a step boundary for the
 * steering queue to drain at. Step 1 calls the tool, step 2 answers.
 */
function twoStepModel(onFirstStep: () => Promise<void>) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      call += 1;
      if (call === 1) {
        const chunks: LanguageModelV3StreamPart[] = [
          { type: "tool-input-start", id: "c1", toolName: "lookup" },
          { type: "tool-input-delta", id: "c1", delta: "{}" },
          { type: "tool-input-end", id: "c1" },
          { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
        ];
        // Land the steering message while step 1 is streaming, so it is queued
        // before the boundary that drains it.
        await onFirstStep();
        return { stream: simulateReadableStream({ chunks }) };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "done" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ],
        }),
      };
    },
  });
}

describe("injected steering messages (TRI-13388)", () => {
  it("enter the accumulator, so onTurnComplete can see them", async () => {
    let captured: { ui: string[]; newUi: string[] } | undefined;
    let injectedCount = 0;

    const send = { fn: async () => {} };

    const agent = chat.agent({
      id: "steering-accumulator",
      tools: {
        lookup: tool({
          description: "look something up",
          inputSchema: z.object({}),
          execute: async () => ({ ok: true }),
        }),
      },
      pendingMessages: {
        shouldInject: ({ steps }) => steps.length > 0,
        onInjected: ({ messages }) => {
          injectedCount = messages.length;
        },
      },
      onTurnComplete: async ({ uiMessages, newUIMessages }) => {
        captured = {
          ui: uiMessages.map(textOf),
          newUi: newUIMessages.map(textOf),
        };
      },
      run: async ({ messages, tools, signal }) =>
        streamText({
          ...chat.toStreamTextOptions({ tools }),
          model: twoStepModel(() => send.fn()),
          messages,
          abortSignal: signal,
          stopWhen: stepCountIs(5),
        }),
    });

    const harness = mockChatAgent(agent, { chatId: "steering-accumulator" });

    send.fn = async () => {
      await harness.sendPendingMessage(userMessage("actually, only the platform one", "steer-1"));
    };

    try {
      await harness.sendMessage(userMessage("summarise every project", "u1"));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The injection happened — this is the SDK's own bookkeeping.
      expect(injectedCount).toBe(1);

      expect(captured).toBeDefined();

      /**
       * The steering message reached the model and the browser. Before this fix it
       * reached neither `uiMessages` nor `newUIMessages`, so an app persisting from
       * `onTurnComplete` stored an answer shaped by an instruction it never saw, and
       * rebuilt the next turn's context without it.
       */
      expect(captured!.ui).toContain("actually, only the platform one");
      expect(captured!.newUi).toContain("actually, only the platform one");

      // And in the order it happened: after the question, before the answer.
      expect(captured!.ui.indexOf("actually, only the platform one")).toBeGreaterThan(
        captured!.ui.indexOf("summarise every project")
      );
      expect(captured!.ui.at(-1)).toBe("done");
    } finally {
      await harness.close();
    }
  });
});
