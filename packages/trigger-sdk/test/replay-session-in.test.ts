// Import the test entry point first so the resource catalog is installed.
import "../src/v3/test/index.js";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClientManager } from "@trigger.dev/core/v3";
import { __replaySessionInTailProductionPathForTests as replaySessionInTail } from "../src/v3/ai.js";

// ── Helpers ────────────────────────────────────────────────────────────

function userMessage(id: string, text: string) {
  return {
    id,
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
  };
}

function stubReadRecords(chunks: unknown[]) {
  const records = chunks.map((chunk, i) => ({
    data: chunk,
    id: `evt-${i + 1}`,
    seqNum: i + 1,
  }));
  const spy = vi.fn(async () => ({ records }));
  vi.spyOn(apiClientManager, "clientOrThrow").mockReturnValue({
    readSessionStreamRecords: spy,
  } as never);
  return spy;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("replaySessionInTail", () => {
  it("extracts user messages from kind: 'message' records with submit-message trigger", async () => {
    const u1 = userMessage("u-1", "hello");
    const u2 = userMessage("u-2", "again");
    stubReadRecords([
      {
        kind: "message",
        payload: { chatId: "c1", trigger: "submit-message", message: u1, metadata: { userId: "a" } },
      },
      {
        kind: "message",
        payload: { chatId: "c1", trigger: "submit-message", message: u2, metadata: { userId: "b" } },
      },
    ]);

    const result = await replaySessionInTail("sess");
    expect(result).toHaveLength(2);
    expect(result[0]!.message.id).toBe("u-1");
    expect(result[0]!.seqNum).toBe(1);
    expect(result[0]!.metadata).toEqual({ userId: "a" });
    expect(result[1]!.message.id).toBe("u-2");
    expect(result[1]!.seqNum).toBe(2);
    expect(result[1]!.metadata).toEqual({ userId: "b" });
  });

  it("ignores non-message variants (stop, handover, handover-skip)", async () => {
    const u1 = userMessage("u-1", "real user");
    stubReadRecords([
      { kind: "stop", message: "user stopped" },
      { kind: "handover-skip" },
      { kind: "handover", partialAssistantMessage: [], isFinal: false },
      { kind: "message", payload: { chatId: "c1", trigger: "submit-message", message: u1 } },
    ]);

    const result = await replaySessionInTail("sess");
    expect(result).toHaveLength(1);
    expect(result[0]!.message.id).toBe("u-1");
  });

  it("ignores message records that aren't submit-message", async () => {
    // regenerate-message / preload / close / action / handover-prepare don't
    // carry a user message — the chain reconstruction must skip them.
    stubReadRecords([
      { kind: "message", payload: { chatId: "c1", trigger: "regenerate-message" } },
      { kind: "message", payload: { chatId: "c1", trigger: "preload" } },
      { kind: "message", payload: { chatId: "c1", trigger: "close" } },
      { kind: "message", payload: { chatId: "c1", trigger: "action", action: { foo: 1 } } },
    ]);

    const result = await replaySessionInTail("sess");
    expect(result).toHaveLength(0);
  });

  it("ignores records whose payload is missing or empty", async () => {
    stubReadRecords([
      { kind: "message" }, // no payload
      { kind: "message", payload: { chatId: "c1", trigger: "submit-message" } }, // no message
      { kind: "message", payload: { chatId: "c1", trigger: "submit-message", message: null } },
      {
        kind: "message",
        payload: { chatId: "c1", trigger: "submit-message", message: "not-an-object" },
      },
    ]);

    const result = await replaySessionInTail("sess");
    expect(result).toHaveLength(0);
  });

  it("skips non-object record data defensively", async () => {
    const u1 = userMessage("u-1", "valid");
    stubReadRecords([
      42,
      null,
      "string-data",
      { kind: "message", payload: { chatId: "c1", trigger: "submit-message", message: u1 } },
    ]);

    const result = await replaySessionInTail("sess");
    expect(result).toHaveLength(1);
    expect(result[0]!.message.id).toBe("u-1");
  });

  it("passes the afterEventId cursor through to readSessionStreamRecords", async () => {
    const spy = stubReadRecords([]);

    await replaySessionInTail("sess", { lastEventId: "evt-42" });

    expect(spy).toHaveBeenCalledWith("sess", "in", { afterEventId: "evt-42" });
  });

  it("returns an empty list when the records endpoint returns no records", async () => {
    stubReadRecords([]);

    const result = await replaySessionInTail("sess");
    expect(result).toEqual([]);
  });
});
