import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { expect } from "vitest";
import type { Call } from "./scripted.js";

const parts = (prompt: LanguageModelV3Prompt) =>
  prompt.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : (message.content as unknown as Array<{ type: string } & Record<string, unknown>>).map(
          (part) => ({
            role: message.role,
            part,
          })
        )
  );

const toolCallIdsIn = (prompt: LanguageModelV3Prompt) =>
  parts(prompt).flatMap(({ part }) =>
    part.type === "tool-call" ? [part.toolCallId as string] : []
  );

export const toolResultIdsIn = (prompt: LanguageModelV3Prompt) =>
  parts(prompt).flatMap(({ part }) =>
    part.type === "tool-result" ? [part.toolCallId as string] : []
  );

export const userTextsIn = (prompt: LanguageModelV3Prompt) =>
  parts(prompt).flatMap(({ role, part }) =>
    role === "user" && part.type === "text" ? [part.text as string] : []
  );

export type ConversationShape = {
  /** The user text that opened each turn, by turn index. */
  turns: string[];
  /**
   * The first call whose prompt is a compaction summary. That call alone may
   * drop what came before it (the summary stands in for it); every step after
   * it must grow again. From there on, messages of earlier turns, and of the
   * compacted turn itself, may have left the prompt.
   */
  compactedAt?: number;
};

/**
 * What every supported conversation guarantees the model, checked on every
 * recorded call. A scenario adds its own expectations on top; these catch the
 * failures nobody wrote a scenario for.
 *
 * Assumes what the scenarios are written to: every user text is distinct
 * across the conversation (a repeated text reads as a repeated message), at
 * most one compaction, and nothing that prunes old tool results. A scenario
 * outside that needs its own checks, not a change to the SDK to fit these.
 */
export function expectConsistentConversation(calls: Call[], shape: ConversationShape) {
  expect(calls.length, "the model was never called").toBeGreaterThan(0);

  calls.forEach((call, i) => {
    const at = `call ${i} (turn ${call.turn})`;
    const results = toolResultIdsIn(call.prompt);
    const texts = userTextsIn(call.prompt);

    // Each tool call the model sees has exactly one result, and no result
    // stands alone or twice.
    expect(results, `${at}: a tool result is repeated`).toEqual([...new Set(results)]);
    expect([...results].sort(), `${at}: tool calls and results do not pair up`).toEqual(
      [...toolCallIdsIn(call.prompt)].sort()
    );

    // No user message is sent twice.
    expect(texts, `${at}: a user message is repeated`).toEqual([...new Set(texts)]);

    // The turn's own message, and every earlier turn's, until a compaction
    // summarises them away.
    const compacted = shape.compactedAt !== undefined && i >= shape.compactedAt;
    const compactedTurn = compacted && calls[shape.compactedAt!]!.turn === call.turn;
    if (!compactedTurn) {
      expect(texts, `${at}: missing this turn's user message`).toContain(shape.turns[call.turn]);
    }
    if (!compacted) {
      for (const earlier of shape.turns.slice(0, call.turn)) {
        expect(texts, `${at}: lost an earlier turn's user message`).toContain(earlier);
      }
    }

    const next = calls[i + 1];
    if (!next || next.turn !== call.turn) return;
    const nextResults = toolResultIdsIn(next.prompt);

    // Within a turn the input moves forward: never the same prompt twice.
    expect(JSON.stringify(next.prompt), `call ${i + 1}: same prompt as call ${i}`).not.toBe(
      JSON.stringify(call.prompt)
    );
    // The compaction call itself replaces what came before with the summary.
    if (i + 1 === shape.compactedAt) return;

    // The next step sees the results of the calls this step made, and keeps
    // what the model already saw.
    expect(nextResults, `call ${i + 1}: missing results of call ${i}'s tools`).toEqual(
      expect.arrayContaining(call.toolCallIds)
    );
    expect(nextResults, `call ${i + 1}: dropped a tool result call ${i} saw`).toEqual(
      expect.arrayContaining(results)
    );
  });
}
