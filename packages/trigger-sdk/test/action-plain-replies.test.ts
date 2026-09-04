import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, streamText } from "ai";
import type { UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * `onAction` is documented to accept a `string` or a `UIMessage` as a reply,
 * not only a stream. Each has to reach the browser, the conversation the next
 * turn is built from, and the snapshot, the same as a streamed reply does.
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
const textChunks = (text: string): LanguageModelV3StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
];
const textOf = (m: { parts?: unknown[] }) =>
  ((m.parts ?? []) as { type: string; text?: string }[])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");

async function runAction(chatId: string, reply: () => unknown, opts?: { compact?: boolean }) {
  const prompts: string[] = [];
  let compacted = 0;
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      return {
        stream: simulateReadableStream({ chunks: textChunks("first answer"), initialDelayInMs: 5 }),
      };
    },
  });
  const agent = chat.agent({
    id: chatId,
    ...(opts?.compact
      ? {
          compaction: {
            shouldCompact: ({ source }) => source === "outer" && compacted === 0,
            summarize: async () => {
              compacted++;
              return "SUMMARY-OF-EVERYTHING";
            },
          },
        }
      : {}),
    actionSchema: z.discriminatedUnion("type", [z.object({ type: z.literal("note") })]),
    onAction: async ({ action }) => (action.type === "note" ? reply() : undefined),
    run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
  });
  const harness = mockChatAgent(agent, { chatId });
  try {
    await harness.sendMessage(userMessage("m1", "u-1"));
    if (opts?.compact) {
      const start = Date.now();
      while (compacted === 0 && Date.now() - start < 5000)
        await new Promise((r) => setTimeout(r, 10));
    }
    await harness.sendAction({ type: "note" });
    await new Promise((r) => setTimeout(r, 80));
    const streamed = (harness.allRawChunks as { type?: string; delta?: string }[])
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta ?? "")
      .join("");
    const snapshot = (harness.getSnapshot()?.messages ?? []).map(textOf);
    const promptsBefore = prompts.length;
    await harness.sendMessage(userMessage("m2", "u-2"));
    return { streamed, snapshot, nextPrompt: prompts[promptsBefore]! };
  } finally {
    await harness.close();
  }
}

describe("a plain reply from onAction", () => {
  it("delivers a returned string like a streamed reply", { timeout: 30_000 }, async () => {
    const r = await runAction("action-string-reply", () => "NOTE-FROM-ACTION");
    expect(r.streamed).toContain("NOTE-FROM-ACTION");
    expect(r.snapshot.at(-1)).toBe("NOTE-FROM-ACTION");
    expect(r.nextPrompt).toContain("NOTE-FROM-ACTION");
  });

  it("delivers a returned UIMessage like a streamed reply", { timeout: 30_000 }, async () => {
    const message = {
      id: "a-note",
      role: "assistant",
      parts: [{ type: "text", text: "UIMESSAGE-FROM-ACTION" }],
    } as UIMessage;
    const r = await runAction("action-uimessage-reply", () => message);
    expect(r.streamed).toContain("UIMESSAGE-FROM-ACTION");
    expect(r.snapshot.at(-1)).toBe("UIMESSAGE-FROM-ACTION");
    expect(r.nextPrompt).toContain("UIMESSAGE-FROM-ACTION");
  });

  it("is appended to a compacted lane rather than rebuilding it", { timeout: 30_000 }, async () => {
    /**
     * Compaction is model-only. Committing the reply by reconverting the UI
     * lane would put the message compaction removed back in front of the model.
     */
    const r = await runAction("action-reply-after-compaction", () => "NOTE-AFTER-COMPACTION", {
      compact: true,
    });
    expect(r.nextPrompt).toContain("SUMMARY-OF-EVERYTHING");
    expect(r.nextPrompt).toContain("NOTE-AFTER-COMPACTION");
    expect(r.nextPrompt).not.toContain("first answer");
  });
});
