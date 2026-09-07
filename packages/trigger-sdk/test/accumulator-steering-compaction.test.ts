import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";

/**
 * `chat.MessageAccumulator` compaction is model-only: it replaces
 * `modelMessages` with a summary and leaves `uiMessages` whole so the chat can
 * still display the conversation. Recording a steer by reconverting
 * `modelMessages` from `uiMessages` therefore restores everything the summary
 * replaced, on the next steer after any compaction.
 *
 * Asserted directly on the accumulator: no run, no model, no harness, because
 * the whole question is which of its two lanes gets written and how.
 */

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
  totalTokens: 15,
};

const userMessage = (text: string, id: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const assistantMessage = (text: string, id: string): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "text", text }] }) as UIMessage;

const flatten = (messages: { content: unknown }[]) => JSON.stringify(messages);

describe("chat.MessageAccumulator steering after compaction", () => {
  it("keeps the summary in the model lane when a later steer is absorbed", async () => {
    const conversation = new chat.MessageAccumulator({
      compaction: {
        shouldCompact: () => true,
        summarize: async () => "SUMMARY-OF-EVERYTHING",
      },
    });

    await conversation.addIncoming([userMessage("EARLY-SENTINEL", "u-1")], "submit-message", 0);
    await conversation.addResponse(assistantMessage("first answer", "a-1"));

    const didCompact = await conversation.compactIfNeeded(USAGE as never);
    expect(didCompact).toBe(true);

    // Compaction is model-only, so the two lanes deliberately disagree here.
    expect(flatten(conversation.modelMessages)).toContain("SUMMARY-OF-EVERYTHING");
    expect(flatten(conversation.modelMessages)).not.toContain("EARLY-SENTINEL");
    expect(JSON.stringify(conversation.uiMessages)).toContain("EARLY-SENTINEL");

    await conversation.absorbSteering([userMessage("steer-me", "u-2")]);

    // The steer has to land in both lanes.
    expect(JSON.stringify(conversation.uiMessages)).toContain("steer-me");
    expect(flatten(conversation.modelMessages)).toContain("steer-me");
    // And the compaction has to survive it. Reconverting from the UI lane
    // brings the compacted message back and drops the summary.
    expect(flatten(conversation.modelMessages)).toContain("SUMMARY-OF-EVERYTHING");
    expect(flatten(conversation.modelMessages)).not.toContain("EARLY-SENTINEL");
  });
});
