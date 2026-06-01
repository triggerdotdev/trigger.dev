import { describe, expect, it } from "vitest";

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
