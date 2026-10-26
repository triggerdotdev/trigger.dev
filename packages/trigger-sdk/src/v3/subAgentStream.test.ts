import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { readUIMessageStream } from "../imports/ai-runtime.js";
import {
  SUB_AGENT_DATA_TYPE,
  createSubAgentMessages,
  forwardSubAgentChunks,
  type SubAgentDataChunk,
} from "./subAgentStream.js";

function subAgentReply(options: {
  toolResults: number;
  toolResultChars: number;
  deltas: number;
}): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [{ type: "start", messageId: "sub-1" }, { type: "start-step" }];
  for (let index = 0; index < options.toolResults; index++) {
    const toolCallId = `search-${index}`;
    chunks.push(
      { type: "tool-input-available", toolCallId, toolName: "search", input: { query: "q" } },
      {
        type: "tool-output-available",
        toolCallId,
        output: { page: "p".repeat(options.toolResultChars) },
      }
    );
  }
  chunks.push({ type: "text-start", id: "t1" });
  for (let index = 0; index < options.deltas; index++) {
    chunks.push({ type: "text-delta", id: "t1", delta: `word${index} ` });
  }
  chunks.push({ type: "text-end", id: "t1" }, { type: "finish-step" }, { type: "finish" });
  return chunks;
}

function streamOf(chunks: UIMessageChunk[]) {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of structuredClone(chunks)) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function snapshots(chunks: UIMessageChunk[]) {
  const all: UIMessage[] = [];
  for await (const message of readUIMessageStream({ stream: streamOf(chunks) })) {
    all.push(message);
  }
  return all;
}

async function forward(chunks: UIMessageChunk[], flushIntervalMs = 50) {
  const written: SubAgentDataChunk[] = [];
  const message = await forwardSubAgentChunks(streamOf(chunks), {
    toolCallId: "call-1",
    flushIntervalMs,
    write: (chunk) => written.push(chunk),
  });
  return { message, written };
}

function textOf(message: UIMessage | undefined) {
  return (message?.parts ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

async function settle(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("forwardSubAgentChunks", () => {
  it("writes every chunk once, in order, and returns the final message", async () => {
    const chunks = subAgentReply({ toolResults: 3, toolResultChars: 2_000, deltas: 200 });
    const { message, written } = await forward(chunks);

    expect(written.every((chunk) => chunk.type === SUB_AGENT_DATA_TYPE && chunk.transient)).toBe(
      true
    );
    expect(written.map((chunk) => chunk.data.seq)).toEqual(written.map((_, index) => index));
    expect(written.flatMap((chunk) => chunk.data.chunks)).toEqual(chunks);
    expect(message).toEqual((await snapshots(chunks)).at(-1));
  });

  it("writes bytes linear in the reply, where snapshots grow with its square", async () => {
    const chunks = subAgentReply({ toolResults: 5, toolResultChars: 20_000, deltas: 2_000 });
    const { written } = await forward(chunks);

    const chunkChars = chunks.reduce((total, chunk) => total + JSON.stringify(chunk).length, 0);
    const forwardedChars = written.reduce(
      (total, chunk) => total + JSON.stringify(chunk).length,
      0
    );
    const snapshotChars = (await snapshots(chunks)).reduce(
      (total, message) => total + JSON.stringify(message).length,
      0
    );

    expect(forwardedChars).toBeLessThan(chunkChars * 1.2);
    expect(snapshotChars).toBeGreaterThan(forwardedChars * 100);
  });

  it("starts a new batch before a large chunk would push one past the size cap", async () => {
    const chunks = subAgentReply({ toolResults: 4, toolResultChars: 100_000, deltas: 10 });
    const { written } = await forward(chunks, 10_000);

    for (const chunk of written) {
      const chars = chunk.data.chunks.reduce((total, c) => total + JSON.stringify(c).length, 0);
      expect(chunk.data.chunks.length === 1 || chars <= 128 * 1024).toBe(true);
    }
    expect(written.length).toBeGreaterThanOrEqual(4);
  });

  it("writes each chunk on its own when flushIntervalMs is 0", async () => {
    const chunks = subAgentReply({ toolResults: 1, toolResultChars: 100, deltas: 20 });
    const { written } = await forward(chunks, 0);

    expect(written).toHaveLength(chunks.length);
    expect(written.every((chunk) => chunk.data.chunks.length === 1)).toBe(true);
  });

  it("flushes what it has when the sub-agent stream fails", async () => {
    const written: SubAgentDataChunk[] = [];
    const pending: UIMessageChunk[] = [
      { type: "start", messageId: "sub-1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "partial" },
    ];
    const source = new ReadableStream<UIMessageChunk>({
      pull(controller) {
        const next = pending.shift();
        if (next) controller.enqueue(next);
        else controller.error(new Error("sub-agent run crashed"));
      },
    });

    await expect(
      forwardSubAgentChunks(source, {
        toolCallId: "call-1",
        flushIntervalMs: 50,
        write: (chunk) => written.push(chunk),
      })
    ).rejects.toThrow("sub-agent run crashed");
    expect(written.flatMap((chunk) => chunk.data.chunks)).toHaveLength(3);
  });
});

describe("createSubAgentMessages", () => {
  it("rebuilds each sub-agent's message from its batches", async () => {
    const first = subAgentReply({ toolResults: 1, toolResultChars: 500, deltas: 50 });
    const second = subAgentReply({ toolResults: 0, toolResultChars: 0, deltas: 5 });
    const store = createSubAgentMessages({ throttleMs: 5 });

    for (const chunk of (await forward(first)).written) store.onData(chunk);
    for (const chunk of (await forward(second)).written) {
      store.onData({ ...chunk, data: { ...chunk.data, toolCallId: "call-2" } });
    }
    await settle();

    expect(store.get("call-1")).toEqual((await snapshots(first)).at(-1));
    expect(textOf(store.get("call-2"))).toBe(textOf((await snapshots(second)).at(-1)));
  });

  it("skips batches replayed after a reconnect", async () => {
    const chunks = subAgentReply({ toolResults: 0, toolResultChars: 0, deltas: 40 });
    const { written } = await forward(chunks, 0);
    const store = createSubAgentMessages({ throttleMs: 5 });

    const half = Math.floor(written.length / 2);
    for (const chunk of written.slice(0, half)) store.onData(chunk);
    for (const chunk of written) store.onData(chunk);
    await settle();

    expect(textOf(store.get("call-1"))).toBe(textOf((await snapshots(chunks)).at(-1)));
  });

  it("rebuilds at most once per throttle window while chunks stream in", async () => {
    const chunks = subAgentReply({ toolResults: 0, toolResultChars: 0, deltas: 300 });
    const { written } = await forward(chunks, 0);
    let changes = 0;
    const store = createSubAgentMessages({ throttleMs: 20, onChange: () => changes++ });

    for (const chunk of written) {
      store.onData(chunk);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await settle(60);

    expect(changes).toBeGreaterThan(0);
    expect(changes).toBeLessThan(written.length / 5);
    expect(textOf(store.get("call-1"))).toBe(textOf((await snapshots(chunks)).at(-1)));
  });

  it("ignores other data parts and stops after dispose", async () => {
    const { written } = await forward(
      subAgentReply({ toolResults: 0, toolResultChars: 0, deltas: 3 })
    );
    let changes = 0;
    const store = createSubAgentMessages({ throttleMs: 5, onChange: () => changes++ });

    store.onData({ type: "data-progress", data: { toolCallId: "call-1", seq: 0, chunks: [] } });
    await settle();
    expect(store.get("call-1")).toBeUndefined();

    store.onData(written[0]!);
    store.dispose();
    await settle();
    expect(changes).toBe(0);
    expect(store.get("call-1")).toBeUndefined();
  });
});
