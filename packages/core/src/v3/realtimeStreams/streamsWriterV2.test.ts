import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatChunkTooLargeError, isChatChunkTooLargeError } from "../errors.js";

const lastAckedPosition = vi.fn(() => undefined);

const appendSession = vi.fn(async () => {
  // A WritableStream that just consumes records — we never reach S2 because
  // the size check fires upstream of this for the oversize case, but we still
  // need a valid writable for the small-chunk path.
  const writable = new WritableStream<unknown>({});
  return {
    writable,
    lastAckedPosition,
  };
});

vi.mock("@s2-dev/streamstore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@s2-dev/streamstore")>();
  return {
    ...actual,
    S2: class FakeS2 {
      basin() {
        return {
          stream: () => ({
            appendSession,
          }),
        };
      }
    },
  };
});

import { StreamsWriterV2 } from "./streamsWriterV2.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("StreamsWriterV2", () => {
  it("rejects with ChatChunkTooLargeError when a single chunk exceeds the per-record cap", async () => {
    const oversized = {
      type: "tool-output-available",
      output: { text: "x".repeat(2_000_000) },
    };
    const source = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });

    const writer = new StreamsWriterV2({
      basin: "test",
      stream: "test",
      accessToken: "test",
      source,
    });

    await expect(writer.wait()).rejects.toBeInstanceOf(ChatChunkTooLargeError);

    let captured: unknown;
    try {
      await writer.wait();
    } catch (err) {
      captured = err;
    }
    expect(isChatChunkTooLargeError(captured)).toBe(true);
    const e = captured as ChatChunkTooLargeError;
    expect(e.chunkType).toBe("tool-output-available");
    expect(e.chunkSize).toBeGreaterThan(1_000_000);
    expect(e.maxSize).toBe(1024 * 1024 - 1024);
    expect(e.message).toMatch(/tool-output-available/);
    expect(e.message).toMatch(/chat\.agent chunk/);
  });

  it("uses chunk.kind when chunk.type is missing (ChatInputChunk-style)", async () => {
    const oversized = {
      kind: "action",
      payload: "x".repeat(2_000_000),
    };
    const source = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });

    const writer = new StreamsWriterV2({
      basin: "test",
      stream: "test",
      accessToken: "test",
      source,
    });

    let captured: unknown;
    try {
      await writer.wait();
    } catch (err) {
      captured = err;
    }
    expect(isChatChunkTooLargeError(captured)).toBe(true);
    expect((captured as ChatChunkTooLargeError).chunkType).toBe("action");
  });

  it("omits chunkType when chunk has no discriminant", async () => {
    const oversized = "x".repeat(2_000_000);
    const source = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });

    const writer = new StreamsWriterV2({
      basin: "test",
      stream: "test",
      accessToken: "test",
      source,
    });

    let captured: unknown;
    try {
      await writer.wait();
    } catch (err) {
      captured = err;
    }
    expect(isChatChunkTooLargeError(captured)).toBe(true);
    expect((captured as ChatChunkTooLargeError).chunkType).toBeUndefined();
  });

  it("does not reject for chunks under the cap", async () => {
    const small = { type: "text-delta", delta: "hello" };
    const source = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue(small);
        controller.close();
      },
    });

    const writer = new StreamsWriterV2({
      basin: "test",
      stream: "test",
      accessToken: "test",
      source,
    });

    await expect(writer.wait()).resolves.toBeDefined();
  });
});
