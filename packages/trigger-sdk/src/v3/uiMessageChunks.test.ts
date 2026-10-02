import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { readUIMessageStream } from "../imports/ai-runtime.js";
import { reduceUIMessageChunks } from "./uiMessageChunks.js";

async function lastSnapshot(chunks: UIMessageChunk[], message?: UIMessage) {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of structuredClone(chunks)) controller.enqueue(chunk);
      controller.close();
    },
  });
  let last: UIMessage | undefined;
  for await (const snapshot of readUIMessageStream({
    stream,
    ...(message ? { message: structuredClone(message) } : {}),
  })) {
    last = snapshot;
  }
  return last;
}

async function withTimerGaps<T>(run: () => Promise<T>) {
  let last = performance.now();
  let maxGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
  }, 5);
  try {
    const result = await run();
    maxGapMs = Math.max(maxGapMs, performance.now() - last);
    return { result, maxGapMs };
  } finally {
    clearInterval(timer);
  }
}

function toolCalls(count: number): UIMessageChunk[] {
  return Array.from({ length: count }, (_, index): UIMessageChunk[] => {
    const toolCallId = `call-${index}`;
    return [
      { type: "tool-input-start", toolCallId, toolName: "lookup" },
      { type: "tool-input-delta", toolCallId, inputTextDelta: '{"id":1}' },
      { type: "tool-input-available", toolCallId, toolName: "lookup", input: { id: 1 } },
      { type: "tool-output-available", toolCallId, output: "pending", preliminary: true },
      { type: "tool-output-available", toolCallId, output: "done" },
    ];
  }).flat();
}

const assistant: UIMessage = {
  id: "assistant-1",
  role: "assistant",
  parts: [{ type: "text", text: "before ", state: "done" }],
};

const sequences: Record<string, UIMessageChunk[]> = {
  "finished multi-step turn": [
    { type: "start", messageId: "msg-1", messageMetadata: { model: "a" } },
    { type: "start-step" },
    { type: "reasoning-start", id: "r1" },
    { type: "reasoning-delta", id: "r1", delta: "thinking" },
    { type: "reasoning-end", id: "r1" },
    ...toolCalls(5),
    { type: "finish-step" },
    { type: "start-step" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "answer" },
    { type: "text-end", id: "t1" },
    { type: "data-progress", id: "p1", data: { step: 1 } },
    { type: "data-progress", id: "p1", data: { step: 2 } },
    { type: "data-ping", data: 1, transient: true },
    { type: "source-url", sourceId: "s1", url: "https://example.com" },
    { type: "message-metadata", messageMetadata: { tokens: 3 } },
    { type: "finish-step" },
    { type: "finish", messageMetadata: { done: true } },
  ],
  "unfinished turn with an interrupted tool call": [
    { type: "start", messageId: "msg-2" },
    { type: "start-step" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "partial" },
    ...toolCalls(2),
    { type: "tool-input-start", toolCallId: "interrupted", toolName: "lookup" },
    { type: "tool-input-delta", toolCallId: "interrupted", inputTextDelta: '{"id":' },
  ],
  "segment resumed without a start chunk": [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "resumed" },
  ],
  "start without a message ID": [{ type: "start" }, { type: "text-start", id: "t1" }],
  "start with an empty message ID": [{ type: "start", messageId: "" }],
  "start with only metadata": [{ type: "start", messageMetadata: { a: 1 } }],
  "error chunk mid-stream": [
    { type: "start", messageId: "msg-3" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "kept" },
    { type: "error", errorText: "provider failed" },
  ],
};

describe("reduceUIMessageChunks", () => {
  it.each(Object.entries(sequences))(
    "matches readUIMessageStream's last snapshot: %s",
    async (_, chunks) => {
      expect(await reduceUIMessageChunks(chunks)).toEqual(await lastSnapshot(chunks));
    }
  );

  it.each(Object.entries(sequences))(
    "matches readUIMessageStream's last snapshot when continuing a message: %s",
    async (_, chunks) => {
      expect(await reduceUIMessageChunks(chunks, { message: assistant })).toEqual(
        await lastSnapshot(chunks, assistant)
      );
    }
  );

  it("returns undefined when no chunk would produce a message", async () => {
    expect(await reduceUIMessageChunks([])).toBeUndefined();
    expect(
      await reduceUIMessageChunks([
        { type: "start" },
        { type: "start-step" },
        { type: "data-ping", data: 1, transient: true },
        { type: "finish-step" },
        { type: "finish" },
      ])
    ).toBeUndefined();
  });

  it("keeps what was reduced before a malformed chunk", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "msg-4" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "kept" },
      { type: "text-delta", id: "missing", delta: "boom" },
      { type: "text-delta", id: "t1", delta: " dropped" },
    ];
    const message = await reduceUIMessageChunks(chunks);
    expect(message).toEqual(await lastSnapshot(chunks));
    expect(message?.parts).toEqual([{ type: "text", text: "kept", state: "streaming" }]);
  });

  it("returns a message that shares no objects with the chunks", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "msg-5", messageMetadata: { tags: ["a"] } },
      { type: "data-card", id: "c1", data: { text: "before" } },
      { type: "tool-input-start", toolCallId: "call", toolName: "lookup" },
      { type: "tool-input-available", toolCallId: "call", toolName: "lookup", input: { q: "x" } },
      { type: "tool-output-available", toolCallId: "call", output: { rows: [1] } },
    ];
    const before = structuredClone(chunks);
    const first = (await reduceUIMessageChunks(chunks))!;
    const expected = structuredClone(first);
    (first.metadata as { tags: string[] }).tags.push("b");
    for (const part of first.parts as Array<Record<string, any>>) {
      if (part.type === "data-card") part.data.text = "after";
      if (part.type === "tool-lookup") {
        part.input.q = "y";
        part.output.rows.push(2);
      }
    }
    expect(chunks).toEqual(before);
    expect(await reduceUIMessageChunks(chunks)).toEqual(expected);
  });

  it("does not mutate the chunks or the continued message", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "start" },
      { type: "data-progress", id: "p1", data: 1 },
      { type: "data-progress", id: "p1", data: 2 },
    ];
    const before = structuredClone(chunks);
    const message = structuredClone(assistant);
    await reduceUIMessageChunks(chunks, { message });
    expect(chunks).toEqual(before);
    expect(message).toEqual(assistant);
  });

  it("reduces a very long unfinished turn without blocking timers", async () => {
    const deltas = 200_000;
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "long" },
      { type: "text-start", id: "t1" },
      ...Array.from(
        { length: deltas },
        (): UIMessageChunk => ({ type: "text-delta", id: "t1", delta: "some text " })
      ),
    ];
    const startedAt = performance.now();
    const { result: message, maxGapMs } = await withTimerGaps(() => reduceUIMessageChunks(chunks));
    expect(message?.parts).toEqual([
      { type: "text", text: "some text ".repeat(deltas), state: "streaming" },
    ]);
    expect(performance.now() - startedAt).toBeLessThan(10_000);
    expect(maxGapMs).toBeLessThan(1_000);
  });

  it("recovers from a malformed chunk after a long prefix without blocking timers", async () => {
    const deltas = 20_000;
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "long" },
      { type: "text-start", id: "t1" },
      ...Array.from(
        { length: deltas },
        (): UIMessageChunk => ({ type: "text-delta", id: "t1", delta: "some text ".repeat(10) })
      ),
      { type: "text-delta", id: "missing", delta: "boom" },
    ];
    const { result: message, maxGapMs } = await withTimerGaps(() => reduceUIMessageChunks(chunks));
    expect(message?.parts).toEqual([
      { type: "text", text: "some text ".repeat(10 * deltas), state: "streaming" },
    ]);
    expect(maxGapMs).toBeLessThan(1_000);
  });
});
