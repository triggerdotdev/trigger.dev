import { describe, expect, it } from "vitest";
import { AppendRecord, BatchTransform } from "@s2-dev/streamstore";

import { ChatChunkTooLargeError, isChatChunkTooLargeError } from "../errors.js";
import { encodeChunkOrError } from "./streamsWriterV2.js";

// The size cap and discriminant extraction are the only S2-independent bits
// of `StreamsWriterV2` that benefit from unit coverage. Both live in the
// `encodeChunkOrError` pure helper, so the tests exercise it directly — no
// `vi.mock("@s2-dev/streamstore", ...)` shim needed.

describe("encodeChunkOrError", () => {
  it("flags oversize chunks and carries the chunk's `type` discriminant", () => {
    const oversized = {
      type: "tool-output-available",
      output: { text: "x".repeat(2_000_000) },
    };

    const result = encodeChunkOrError(oversized);

    expect(result.ok).toBe(false);
    if (result.ok) return; // type guard
    expect(isChatChunkTooLargeError(result.error)).toBe(true);
    expect(result.error.chunkType).toBe("tool-output-available");
    expect(result.error.chunkSize).toBeGreaterThan(1_000_000);
    expect(result.error.maxSize).toBe(1024 * 1024 - 1024);
    expect(result.error.message).toMatch(/tool-output-available/);
    expect(result.error.message).toMatch(/chat\.agent chunk/);
  });

  it("falls back to chunk.kind when chunk.type is missing (ChatInputChunk-style)", () => {
    const oversized = { kind: "action", payload: "x".repeat(2_000_000) };

    const result = encodeChunkOrError(oversized);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.chunkType).toBe("action");
  });

  it("omits chunkType when the chunk has no discriminant", () => {
    const oversized = "x".repeat(2_000_000);

    const result = encodeChunkOrError(oversized);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.chunkType).toBeUndefined();
  });

  it("returns the encoded body for chunks under the cap", () => {
    const small = { type: "text-delta", delta: "hello" };

    const result = encodeChunkOrError(small);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.body) as { data: unknown; id: string };
    expect(parsed.data).toEqual(small);
    expect(parsed.id).toMatch(/^[A-Za-z0-9_-]{7}$/); // nanoid(7)
  });
});

// Cross-check the ChatChunkTooLargeError type-guard helper itself. Trivial,
// but keeps the test surface here exercising the public error helpers a
// consumer would import from the same module.
describe("isChatChunkTooLargeError", () => {
  it("recognizes its own error class", () => {
    const err = new ChatChunkTooLargeError(2_000_000, 1024 * 1024 - 1024, "x");
    expect(isChatChunkTooLargeError(err)).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isChatChunkTooLargeError(new Error("nope"))).toBe(false);
    expect(isChatChunkTooLargeError("string")).toBe(false);
    expect(isChatChunkTooLargeError(undefined)).toBe(false);
  });
});

// Regression guard for the `@s2-dev/streamstore` linger-timer race that
// surfaced as `TASK_RUN_UNCAUGHT_EXCEPTION` ("Invalid state: Unable to
// enqueue") in `chat.agent`. `StreamsWriterV2` pipes records through a
// `BatchTransform` into S2's `session.writable`. When a run aborts mid-turn
// while a record is still buffered in the linger window, the writable is
// aborted and the transform's readable controller errors — but the pending
// linger `setTimeout` still fires and calls `controller.enqueue()` on the
// now-dead controller, throwing from a timer callback (so it's uncaught).
//
// Fixed upstream in `@s2-dev/streamstore@0.22.10` by wrapping the linger
// flush in a try/catch that discards the closed-controller `TypeError`. This
// test exercises the *real* `BatchTransform` (no mock) and fails if the
// dependency is ever downgraded below the fix.
describe("BatchTransform linger-timer abort safety (s2 dependency contract)", () => {
  it("does not throw an uncaught error when the controller dies before the linger fires", async () => {
    const lingerDurationMillis = 50;
    const captured: unknown[] = [];
    const onUncaught = (err: unknown) => captured.push(err);

    // Intercept uncaught errors from the linger timer for the duration of the
    // test — the throw happens in a `setTimeout`, so it can't be caught with a
    // surrounding try/catch.
    const prevUncaught = process.listeners("uncaughtException");
    const prevUnhandled = process.listeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUncaught);

    try {
      // Mirror the StreamsWriterV2 pipeline shape: source -> BatchTransform ->
      // session.writable. The downstream never acks, so the buffered record
      // stays in the linger window until we abort.
      const batcher = new BatchTransform({ lingerDurationMillis });
      const downstream = new WritableStream({
        write() {
          return new Promise(() => {});
        },
      });
      batcher.readable.pipeTo(downstream).catch(() => {});

      const writer = batcher.writable.getWriter();
      // Buffer a record — this arms the linger setTimeout.
      await writer.write(AppendRecord.string({ body: "hello" }));
      // Abort the downstream before the linger fires (== run suspend/abort ->
      // session.writable.abort()), which errors the transform's readable side.
      await downstream.abort?.("aborted").catch(() => {});
      writer.abort("aborted").catch(() => {});
      // Wait past the linger window so the pending timer fires on the dead
      // controller.
      await new Promise((r) => setTimeout(r, lingerDurationMillis + 150));
    } finally {
      process.removeListener("uncaughtException", onUncaught);
      process.removeListener("unhandledRejection", onUncaught);
      prevUncaught.forEach((l) => process.on("uncaughtException", l));
      prevUnhandled.forEach((l) => process.on("unhandledRejection", l));
    }

    expect(captured).toEqual([]);
  });
});
