import {
  convertToModelMessages,
  readUIMessageStream,
  type ModelMessage,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { responseAfterCompaction } from "./compactionResponse.js";
import { restoreModelLane } from "./transcriptStorage.js";

const summary: ModelMessage = { role: "assistant", content: "SUMMARY" };
const oldUser: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "OLD_USER" }] };
const nextUser: UIMessage = {
  id: "u2",
  role: "user",
  parts: [{ type: "text", text: "NEXT_QUESTION" }],
};
const convert = (messages: UIMessage[]) =>
  convertToModelMessages(messages, { ignoreIncompleteToolCalls: true });
const text = (messages: unknown) => JSON.stringify(messages);
const step = (...parts: UIMessage["parts"]): UIMessage["parts"] => [
  { type: "step-start" },
  ...parts,
];
const toolResult = (
  id: string,
  output: string,
  providerExecuted = false
): UIMessage["parts"][number] => ({
  type: "dynamic-tool",
  toolName: "lookup",
  toolCallId: id,
  state: "output-available",
  input: { id },
  output,
  providerExecuted,
});
function response(compactedSteps: number): UIMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [
      ...Array.from({ length: compactedSteps }, (_, i) =>
        step({ type: "text", text: `OLD_ASSISTANT_${i}` }, toolResult(`old-${i}`, `OLD_TOOL_${i}`))
      ).flat(),
      ...step(toolResult("new", "NEW_TOOL")),
      ...step({ type: "text", text: "NEW_ANSWER" }),
    ],
  };
}

describe("response model history after inner compaction", () => {
  it.each([1, 2, 3])(
    "keeps only the response after %i compacted steps, including on restoration",
    async (count) => {
      const ui = response(count);
      const before = structuredClone(ui);
      const model = [summary, ...(await convert([responseAfterCompaction(ui, count)]))];
      expect(text(model)).toContain("SUMMARY");
      expect(text(model)).toContain("NEW_TOOL");
      expect(text(model)).toContain("NEW_ANSWER");
      expect.soft(text(model)).not.toContain("OLD_ASSISTANT");
      expect.soft(text(model)).not.toContain("OLD_TOOL");
      expect(ui).toEqual(before);
      expect(text(ui)).toContain("OLD_TOOL");
      const state = JSON.parse(
        JSON.stringify({ v: 1, compaction: { modelMessages: model, throughId: ui.id } })
      );
      const restored = await restoreModelLane([oldUser, ui, nextUser], state, convert);
      expect.soft(text(restored.messages)).not.toContain("OLD_");
      expect(restored.messages).toEqual([...model, ...(await convert([nextUser]))]);
    }
  );

  it("keeps the complete response when this turn did not compact", () => {
    const ui = response(1);
    expect(responseAfterCompaction(ui)).toBe(ui);
  });

  it("does not confuse an empty or hidden-reasoning step with a model message", async () => {
    const ui: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        ...step(), // A provider step whose reasoning was omitted from the UI stream.
        ...step(toolResult("old", "OLD_TOOL", true)),
        ...step({ type: "text", text: "NEW_ANSWER" }),
      ],
    };
    const model = await convert([responseAfterCompaction(ui, 2)]);
    expect(model).toEqual([{ role: "assistant", content: [{ type: "text", text: "NEW_ANSWER" }] }]);
  });

  it("retains a partially streamed post-compaction answer", async () => {
    const ui: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        ...step(toolResult("old", "OLD_TOOL")),
        ...step({ type: "text", text: "PARTIAL", state: "streaming" }),
      ],
    };
    const model = await convert([responseAfterCompaction(ui, 1)]);
    expect(text(model)).toContain("PARTIAL");
    expect(text(model)).not.toContain("OLD_TOOL");
  });

  it("appends nothing if stopped before the first post-compaction step", async () => {
    const ui: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: step(toolResult("old", "OLD_TOOL")),
    };
    expect(await convert([responseAfterCompaction(ui, 1)])).toEqual([]);
  });

  it.each([true, false])(
    "handles a same-ID continuation whose original has step markers: %s",
    async (hasMarkers) => {
      const original: UIMessage = {
        id: "a1",
        role: "assistant",
        parts: [
          ...(hasMarkers ? [{ type: "step-start" as const }] : []),
          toolResult("prior", "PRIOR_TURN_TOOL"),
        ],
      };
      const ui = response(1);
      ui.parts.unshift(...original.parts);
      const originalBefore = structuredClone(original);
      const model = await convert([responseAfterCompaction(ui, 1, original)]);
      expect(text(model)).toContain("NEW_ANSWER");
      expect(text(model)).toContain("NEW_TOOL");
      expect(text(model)).not.toContain("OLD_");
      expect(text(model)).not.toContain("PRIOR_TURN_TOOL");
      expect(original).toEqual(originalBefore);
    }
  );

  it("ignores an original response with a different ID", async () => {
    const original = { ...response(3), id: "other" };
    const model = await convert([responseAfterCompaction(response(1), 1, original)]);
    expect(text(model)).toContain("NEW_ANSWER");
    expect(text(model)).not.toContain("OLD_");
  });

  it("keeps post-compaction provider tools and custom tool output conversion", async () => {
    const ui: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [...step(toolResult("old", "OLD_TOOL")), ...step(toolResult("new", "NEW_TOOL", true))],
    };
    const model = await convertToModelMessages([responseAfterCompaction(ui, 1)], {
      tools: {
        lookup: {
          inputSchema: z.object({ id: z.string() }),
          toModelOutput: ({ output }: { output: unknown }) => ({
            type: "text" as const,
            value: `CONVERTED:${output}`,
          }),
        },
      },
    });
    expect(model).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "new",
            toolName: "lookup",
            input: { id: "new" },
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "new",
            toolName: "lookup",
            output: { type: "text", value: "CONVERTED:NEW_TOOL" },
          },
        ],
      },
    ]);
  });

  it("uses the step boundaries produced by the real UI stream reader", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "a1" },
      { type: "start-step" },
      { type: "tool-input-available", toolCallId: "old", toolName: "lookup", input: {} },
      { type: "tool-output-available", toolCallId: "old", output: "OLD_TOOL" },
      { type: "finish-step" },
      { type: "start-step" },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "NEW_ANSWER" },
      { type: "text-end", id: "t" },
      { type: "finish-step" },
      { type: "finish" },
    ];
    let ui: UIMessage | undefined;
    for await (const message of readUIMessageStream({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    }))
      ui = message;
    expect(ui).toBeDefined();
    expect(text(await convert([responseAfterCompaction(ui!, 1)]))).not.toContain("OLD_TOOL");
    expect(text(ui)).toContain("OLD_TOOL");
  });
});
