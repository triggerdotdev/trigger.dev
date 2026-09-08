import http2 from "node:http2";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { ChatChunkTooLargeError, isChatChunkTooLargeError } from "../errors.js";
import { StreamsWriterV2, encodeChunkOrError } from "./streamsWriterV2.js";

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

// A session `.out` stream that S2 reports as not found (the head-start drain
// can append before the stream is visible). The writer is detached — nothing
// awaits it until the handover flush — so a rejecting append used to escape
// as an unhandled rejection and take the whole process down.
describe("StreamsWriterV2 against a stream S2 does not have", () => {
  it("keeps the append failure on `wait()` instead of emitting an unhandled rejection", async () => {
    const server = http2.createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ message: "stream sessions/chat_x/out not found", code: "not_found" })
      );
    });
    const sessions = new Set<http2.ServerHttp2Session>();
    server.on("session", (session) => {
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const writer = new StreamsWriterV2<string>({
        basin: "trigger-local",
        stream: "sessions/chat_x/out",
        accessToken: "token",
        endpoint: `http://127.0.0.1:${port}/v1`,
        source: new ReadableStream<string>({
          start(controller) {
            controller.enqueue("hello");
            controller.close();
          },
        }),
        flushIntervalMs: 5,
      });

      // Long enough for the append to fail and for Node to flag an unhandled
      // rejection, without anything having awaited the writer yet.
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      expect(rejections).toEqual([]);
      await expect(writer.wait()).rejects.toThrow(/not found/);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  // Same escape route when the SDK's own append retries run out. Reached via
  // the retry loop's session-creation branch, not the ack-timeout branch.
  it("keeps a retry-exhausted append on `wait()`", async () => {
    // Holds the port and refuses every connection, so the retry budget is
    // spent on connection failures with no window for another listener.
    let connectionAttempts = 0;
    const server = net.createServer((socket) => {
      connectionAttempts++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const writer = new StreamsWriterV2<string>({
        basin: "trigger-local",
        stream: "sessions/chat_x/out",
        accessToken: "token",
        endpoint: `http://127.0.0.1:${port}/v1`,
        source: new ReadableStream<string>({
          start(controller) {
            controller.enqueue("hello");
            controller.close();
          },
        }),
        flushIntervalMs: 5,
      });

      // Side channel: wait for the budget (3 attempts) to be spent without
      // touching the writer, then let the abort propagate.
      const deadline = Date.now() + 5_000;
      while (connectionAttempts < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(connectionAttempts).toBeGreaterThanOrEqual(3);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(rejections).toEqual([]);
      // Rejects in a microtask if it already failed; the 0ms timer wins if the
      // writer is somehow still pending, so a slow runner fails instead of
      // passing vacuously.
      await expect(
        Promise.race([
          writer.wait(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("still pending")), 0)),
        ])
      ).rejects.toThrow(/Max attempts \(3\) exhausted/);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
