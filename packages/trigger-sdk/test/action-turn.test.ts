import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * An action is a state edit. One that returns `chat.turn()` is followed by a
 * turn on the edited history, with everything a turn has; one that returns
 * nothing edits and stops; one that returns anything else is an error.
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
async function waitFor(check: () => boolean, label = "condition", timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function agentWith(onAction: (action: { type: string }) => unknown) {
  const prompts: string[] = [];
  const triggers: string[] = [];
  /** The snapshot as it stood when each run() began. */
  const snapshotsAtRun: string[][] = [];
  const starts: number[] = [];
  const completes: { turn: number; finishReason?: string }[] = [];
  let answers = 0;
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      return {
        stream: simulateReadableStream({
          chunks: textChunks(`answer-${answers++}`),
          initialDelayInMs: 5,
        }),
      };
    },
  });
  const agent = chat.agent({
    id: "action-turn",
    onChatStart: async () => {
      chat.prompt.set("AGENT-SYSTEM");
    },
    actionSchema: z.discriminatedUnion("type", [
      z.object({ type: z.literal("regenerate") }),
      z.object({ type: z.literal("undo") }),
      z.object({ type: z.literal("bad") }),
    ]),
    onTurnStart: async ({ turn }) => {
      starts.push(turn);
    },
    onTurnComplete: async ({ turn, finishReason }) => {
      completes.push({ turn, finishReason });
    },
    onAction: async ({ action }) => onAction(action) as never,
    run: async ({ messages, signal, trigger }) => {
      triggers.push(trigger);
      snapshotsAtRun.push((snapshotReader?.()?.messages ?? []).map(textOf));
      return streamText({ model, messages, abortSignal: signal, ...chat.toStreamTextOptions() });
    },
  });
  let snapshotReader: (() => { messages: { parts?: unknown[] }[] } | undefined) | undefined;
  return {
    agent,
    prompts,
    triggers,
    snapshotsAtRun,
    starts,
    completes,
    attach: (h: { getSnapshot: () => { messages: { parts?: unknown[] }[] } | undefined }) => {
      snapshotReader = () => h.getSnapshot();
    },
  };
}

describe("an action that returns chat.turn()", () => {
  it("runs a turn on the edited history, with the turn's own machinery", async () => {
    const { agent, prompts, triggers, snapshotsAtRun, starts, completes, attach } = agentWith(
      (action) => {
        if (action.type === "regenerate") {
          chat.history.slice(0, -1);
          return chat.turn();
        }
        return undefined;
      }
    );
    const harness = mockChatAgent(agent, { chatId: "action-turn-regenerate" });
    attach(harness);
    try {
      await harness.sendMessage(userMessage("ask", "u-1"));
      await waitFor(() => completes.length >= 1, "turn 0");

      await harness.sendAction({ type: "regenerate" });
      await waitFor(() => completes.length >= 2, "the action's turn");

      // It was a turn: hooks fired, and it took the next turn number.
      expect(starts).toEqual([0, 1]);
      expect(completes.map((c) => c.turn)).toEqual([0, 1]);
      // It ran on the edited history with the agent's configuration.
      const p = prompts.at(-1)!;
      expect(p).toContain("AGENT-SYSTEM");
      expect(p).not.toContain("answer-0");
      // Its answer replaced the old one in the conversation.
      expect(harness.getSnapshot()?.messages.map(textOf)).toEqual(["ask", "answer-1"]);
      // run() saw it as a turn requested by an action, not as the action, so a
      // handler that returns early on "action" still answers.
      expect(triggers[1]).toBe("action-turn");
      // And the edit was persisted before the turn began: a turn cut short
      // continues from the edited history, not from the snapshot it replaced.
      expect(snapshotsAtRun[1]).toEqual(["ask"]);

      // And the turn after it is numbered on from there.
      await harness.sendMessage(userMessage("more", "u-2"));
      await waitFor(() => completes.length >= 3, "turn 2");
      expect(completes.at(-1)!.turn).toBe(2);
      expect(prompts.at(-1)!).toContain("answer-1");
    } finally {
      await harness.close();
    }
  });

  it("is still just an edit when nothing is returned", async () => {
    const { agent, starts, completes } = agentWith((action) => {
      if (action.type === "undo") chat.history.slice(0, -2);
    });
    const harness = mockChatAgent(agent, { chatId: "action-turn-undo" });
    try {
      await harness.sendMessage(userMessage("ask", "u-1"));
      await waitFor(() => completes.length >= 1, "turn 0");
      await harness.sendAction({ type: "undo" });
      await new Promise((r) => setTimeout(r, 60));
      expect(starts).toEqual([0]);
      expect(completes).toHaveLength(1);
      expect(harness.getSnapshot()?.messages ?? []).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("rejects any other return value with a pointer to chat.turn()", async () => {
    const { agent, completes } = agentWith((action) => {
      if (action.type === "bad") return "a reply string";
      return undefined;
    });
    const harness = mockChatAgent(agent, { chatId: "action-turn-bad" });
    try {
      await harness.sendMessage(userMessage("ask", "u-1"));
      await waitFor(() => completes.length >= 1, "turn 0");
      await harness.sendAction({ type: "bad" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
      const errors = (harness.allRawChunks as { type?: string; errorText?: string }[])
        .filter((c) => c.type === "error")
        .map((c) => c.errorText ?? "");
      expect(errors.some((e) => e.includes("chat.turn()"))).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
