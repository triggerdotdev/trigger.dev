import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { withToolResultsInCallOrder } from "./toolResultOrder.js";

const result = (toolCallId: string) => ({
  type: "tool-result" as const,
  toolCallId,
  toolName: toolCallId,
  output: { type: "text" as const, value: toolCallId },
});

function step(calls: string[], finished: string[]): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "" },
        ...calls.map((id) => ({
          type: "tool-call" as const,
          toolCallId: id,
          toolName: id,
          input: {},
        })),
      ],
    },
    { role: "tool", content: finished.map(result) },
  ];
}

describe("withToolResultsInCallOrder", () => {
  it("puts results that finished out of order back in call order", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "go" },
      ...step(["list_runs", "list_errors"], ["list_errors", "list_runs"]),
    ];
    const ordered = withToolResultsInCallOrder(messages);
    const ids = (ordered[2]!.content as Array<{ toolCallId: string }>).map((p) => p.toolCallId);
    expect(ids).toEqual(["list_runs", "list_errors"]);
  });

  it("orders each step against its own calls", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "go" },
      ...step(["a", "b"], ["b", "a"]),
      ...step(["c", "d", "e"], ["e", "c", "d"]),
    ];
    const ordered = withToolResultsInCallOrder(messages);
    const ids = (index: number) =>
      (ordered[index]!.content as Array<{ toolCallId: string }>).map((p) => p.toolCallId);
    expect(ids(2)).toEqual(["a", "b"]);
    expect(ids(4)).toEqual(["c", "d", "e"]);
  });

  it("returns the same array when everything is already in call order", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "go" },
      ...step(["a", "b"], ["a", "b"]),
    ];
    expect(withToolResultsInCallOrder(messages)).toBe(messages);
  });

  it("leaves parts that are not results in their slots", () => {
    const approval = { type: "tool-approval-response", approvalId: "x", approved: true };
    const messages = [
      { role: "user", content: "go" },
      step(["a", "b"], [])[0],
      { role: "tool", content: [result("b"), approval, result("a")] },
    ] as unknown as ModelMessage[];
    const content = withToolResultsInCallOrder(messages)[2]!.content as Array<{
      type: string;
      toolCallId?: string;
    }>;
    expect(content.map((p) => p.toolCallId ?? p.type)).toEqual([
      "a",
      "tool-approval-response",
      "b",
    ]);
  });
});
