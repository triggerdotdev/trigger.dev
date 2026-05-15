// Import the test harness FIRST so the resource catalog is installed
// before the agent module is loaded (which registers the task).
import { mockChatAgent } from "@trigger.dev/sdk/ai/test";

import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream, type UIMessage, type UIMessageChunk } from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { testChatAgent } from "./test-chat.js";

// ── Helpers ────────────────────────────────────────────────────────────

let msgCounter = 0;
function userMessage(text: string): UIMessage {
  return {
    id: `u-${++msgCounter}`,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function assistantMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

function modelWithText(text: string) {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
  });
}

function collectText(chunks: UIMessageChunk[]): string {
  return chunks
    .filter((c) => c.type === "text-delta")
    .map((c) => (c as { delta: string }).delta)
    .join("");
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("testChatAgent", () => {
  describe("basic flow", () => {
    it("streams the model's response on a single turn", async () => {
      const model = modelWithText("hello world");
      const harness = mockChatAgent(testChatAgent, {
        chatId: "test-basic",
        clientData: { model },
      });

      try {
        const turn = await harness.sendMessage(userMessage("hi there"));
        expect(collectText(turn.chunks)).toBe("hello world");
      } finally {
        await harness.close();
      }
    });

    it("handles multiple turns with the same harness", async () => {
      const model = modelWithText("ok");
      const harness = mockChatAgent(testChatAgent, {
        chatId: "test-multi",
        clientData: { model },
      });

      try {
        await harness.sendMessage(userMessage("first"));
        await harness.sendMessage(userMessage("second"));

        // Both turns should produce model output chunks
        const turn1Chunks = harness.allChunks.filter((c) => c.type === "text-delta");
        expect(turn1Chunks.length).toBeGreaterThanOrEqual(2);
      } finally {
        await harness.close();
      }
    });
  });

  describe("onValidateMessages (content filter)", () => {
    it("blocks messages containing the forbidden phrase", async () => {
      const model = modelWithText("should never reach here");
      const harness = mockChatAgent(testChatAgent, {
        chatId: "test-block",
        clientData: { model },
      });

      try {
        const turn = await harness.sendMessage(userMessage("hello blocked-word here"));

        // The turn completes with an error chunk, not a text chunk
        expect(collectText(turn.chunks)).toBe("");
        // The turn-complete wire chunk still arrives via rawChunks
        expect(turn.rawChunks.some((c) => {
          return typeof c === "object" && c !== null &&
            (c as { type?: string }).type === "trigger:turn-complete";
        })).toBe(true);
      } finally {
        await harness.close();
      }
    });

    it("allows clean messages through", async () => {
      const model = modelWithText("alright");
      const harness = mockChatAgent(testChatAgent, {
        chatId: "test-allow",
        clientData: { model },
      });

      try {
        const turn = await harness.sendMessage(userMessage("hello there"));
        expect(collectText(turn.chunks)).toBe("alright");
      } finally {
        await harness.close();
      }
    });
  });

  describe("hydrateMessages", () => {
    it("uses clientData.hydrated as the source of truth when provided", async () => {
      const model = modelWithText("ok");
      // Pre-seed the hydrated set with a prior exchange
      const hydrated: UIMessage[] = [
        { id: "h1", role: "user", parts: [{ type: "text", text: "prior question" }] },
        { id: "h2", role: "assistant", parts: [{ type: "text", text: "prior answer" }] },
      ];

      const harness = mockChatAgent(testChatAgent, {
        chatId: "test-hydrate",
        clientData: { model, hydrated: [...hydrated, userMessage("follow up")] },
      });

      try {
        await harness.sendMessage(userMessage("follow up"));

        // Model should have been called with the hydrated context
        expect(model.doStreamCalls).toHaveLength(1);
        const modelMessages = model.doStreamCalls[0]!.prompt;
        expect(modelMessages.length).toBeGreaterThanOrEqual(3);
      } finally {
        await harness.close();
      }
    });
  });

  describe("actions", () => {
    it("handles the undo action via chat.history.slice", async () => {
      const model = modelWithText("ok");
      const harness = mockChatAgent(testChatAgent, {
        chatId: "test-undo",
        clientData: { model },
      });

      try {
        await harness.sendMessage(userMessage("first"));
        await harness.sendMessage(userMessage("second"));

        // Undo — should pop the last user+assistant exchange
        const undoTurn = await harness.sendAction({ type: "undo" });

        // The turn completes normally — undo + re-respond
        expect(undoTurn.rawChunks.some((c) => {
          return typeof c === "object" && c !== null &&
            (c as { type?: string }).type === "trigger:turn-complete";
        })).toBe(true);
      } finally {
        await harness.close();
      }
    });

    it("rejects invalid actions", async () => {
      const model = modelWithText("ok");
      const harness = mockChatAgent(testChatAgent, {
        chatId: "test-invalid",
        clientData: { model },
      });

      try {
        await harness.sendMessage(userMessage("hi"));

        // Send an action that doesn't match the schema
        const turn = await harness.sendAction({ type: "not-a-real-action" });

        // An error chunk should be emitted instead of a clean turn
        const errorChunks = turn.rawChunks.filter((c) => {
          return typeof c === "object" && c !== null &&
            (c as { type?: string }).type === "error";
        });
        expect(errorChunks.length).toBeGreaterThan(0);
      } finally {
        await harness.close();
      }
    });
  });

  describe("model interaction", () => {
    it("forwards the user message to the language model", async () => {
      const model = modelWithText("echo");
      const harness = mockChatAgent(testChatAgent, {
        chatId: "test-forward",
        clientData: { model },
      });

      try {
        await harness.sendMessage(userMessage("the quick brown fox"));

        expect(model.doStreamCalls).toHaveLength(1);
        const call = model.doStreamCalls[0]!;
        // The model should have received a user message with our text
        const userMessages = call.prompt.filter((m) => m.role === "user");
        expect(userMessages).toHaveLength(1);
      } finally {
        await harness.close();
      }
    });
  });
});
