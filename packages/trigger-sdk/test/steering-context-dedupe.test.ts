import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { retainStepMessages } from "../src/v3/steeringContext.js";

/**
 * A head-start handover executes approved tool calls before the first step, so
 * their results open the input an override is retained from and again the
 * generation's response messages. retainStepMessages sends each once.
 */

const toolResult = (value: unknown): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "rows",
      output: { type: "json", value: value as never },
    },
  ],
});

const user: ModelMessage = { role: "user", content: "hi" };
const steer: ModelMessage = { role: "user", content: "steer" };

/** Runs two steps: the first overrides, the second brings `response` back. */
async function nextStepMessages(headStart: ModelMessage, response: ModelMessage[]) {
  const seen: ModelMessage[][] = [];
  const prepare = retainStepMessages(async ({ messages, steps }: any) => {
    seen.push(messages);
    return steps.length === 0 ? { messages: [...messages, steer] } : undefined;
  });
  await prepare({ messages: [user, headStart], steps: [], responseMessages: [] });
  await prepare({
    messages: [user, headStart],
    steps: [{ response: { messages: response } }],
    responseMessages: response,
  });
  return seen[1]!;
}

describe("a head-start result also in the response messages", () => {
  // Catches: a result holding a BigInt being compared as different (or compared
  // by reference only), so a head-start result is sent to the model twice.
  it("is sent once when it holds an equal BigInt", async () => {
    const headStart = toolResult({ count: 10n });
    const messages = await nextStepMessages(headStart, [toolResult({ count: 10n })]);
    expect(messages).toEqual([user, headStart, steer]);
  });

  // Catches: a BigInt encoded as its decimal string, so a result holding 10n is
  // dropped as already sent when the new one holds the string "10".
  it("is sent again when a BigInt meets the same digits as a string", async () => {
    const response = toolResult({ count: "10" });
    const messages = await nextStepMessages(toolResult({ count: 10n }), [response]);
    expect(messages.at(-1)).toBe(response);
    expect(messages).toHaveLength(4);
  });
});
