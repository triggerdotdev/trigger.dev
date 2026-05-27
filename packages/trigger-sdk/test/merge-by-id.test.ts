// Plan F.1: pure-function correctness tests for `mergeByIdReplaceWins`,
// the helper that combines `snapshot.messages` with `session.out` replay
// at run boot (plan section B.3). Replay wins on id collision because
// `session.out` carries the freshest representation of an assistant
// message.

import "../src/v3/test/index.js";

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { __mergeByIdReplaceWinsForTests as mergeByIdReplaceWins } from "../src/v3/ai.js";

// ── Helpers ────────────────────────────────────────────────────────────

function userMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function assistantMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("mergeByIdReplaceWins", () => {
  it("returns a copy of `a` when `b` is empty", () => {
    const a = [userMessage("u-1", "hello")];
    const result = mergeByIdReplaceWins(a, []);
    expect(result).toEqual(a);
    // Verify it's a copy (mutating result shouldn't touch a).
    result.push(assistantMessage("a-1", "extra"));
    expect(a).toHaveLength(1);
  });

  it("returns a copy of `b` when `a` is empty", () => {
    const b = [assistantMessage("a-1", "world")];
    const result = mergeByIdReplaceWins([], b);
    expect(result).toEqual(b);
    result.push(userMessage("u-extra", "extra"));
    expect(b).toHaveLength(1);
  });

  it("returns [] when both inputs are empty", () => {
    expect(mergeByIdReplaceWins([], [])).toEqual([]);
  });

  it("appends fresh ids from `b` after `a`'s entries", () => {
    const a = [userMessage("u-1", "hi")];
    const b = [assistantMessage("a-1", "ok")];
    const result = mergeByIdReplaceWins(a, b);
    expect(result.map((m) => m.id)).toEqual(["u-1", "a-1"]);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
  });

  it("replaces by id when `b` has a colliding entry — replay wins", () => {
    const a = [
      userMessage("u-1", "hi"),
      assistantMessage("a-1", "stale-version"),
    ];
    const b = [assistantMessage("a-1", "fresh-version")];
    const result = mergeByIdReplaceWins(a, b);
    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("a-1");
    expect((result[1]!.parts[0] as { text: string }).text).toBe("fresh-version");
  });

  it("preserves order from `a` even when entries are replaced", () => {
    const a = [
      userMessage("u-1", "first"),
      assistantMessage("a-1", "stale"),
      userMessage("u-2", "second"),
      assistantMessage("a-2", "also-stale"),
    ];
    const b = [
      assistantMessage("a-1", "fresh-1"),
      assistantMessage("a-2", "fresh-2"),
    ];
    const result = mergeByIdReplaceWins(a, b);
    expect(result.map((m) => m.id)).toEqual(["u-1", "a-1", "u-2", "a-2"]);
    expect((result[1]!.parts[0] as { text: string }).text).toBe("fresh-1");
    expect((result[3]!.parts[0] as { text: string }).text).toBe("fresh-2");
  });

  it("appends `b` entries with no id collision after the merged set", () => {
    const a = [userMessage("u-1", "first")];
    const b = [
      assistantMessage("a-1", "reply-1"),
      userMessage("u-2", "second"),
      assistantMessage("a-2", "reply-2"),
    ];
    const result = mergeByIdReplaceWins(a, b);
    expect(result.map((m) => m.id)).toEqual(["u-1", "a-1", "u-2", "a-2"]);
  });

  it("treats messages without an id as always-append (no collision possible)", () => {
    const a = [
      userMessage("u-1", "first"),
      // Synthetic message missing the id field — should append, never replace.
      { id: "" as string, role: "assistant", parts: [{ type: "text", text: "no-id-a" }] } as UIMessage,
    ];
    const b = [
      { id: "" as string, role: "assistant", parts: [{ type: "text", text: "no-id-b" }] } as UIMessage,
    ];
    const result = mergeByIdReplaceWins(a, b);
    expect(result).toHaveLength(3);
    // Both empty-id messages survive — no merge happens.
    const noIdParts = result
      .filter((m) => m.id === "")
      .map((m) => (m.parts[0] as { text: string }).text);
    expect(noIdParts).toEqual(["no-id-a", "no-id-b"]);
  });

  it("handles consecutive replays of the same id in `b` — last one wins", () => {
    // Edge case: `b` has two entries with the same id (shouldn't happen
    // for assistants in practice, but the helper must be deterministic).
    const a = [assistantMessage("a-1", "v0")];
    const b = [assistantMessage("a-1", "v1"), assistantMessage("a-1", "v2")];
    const result = mergeByIdReplaceWins(a, b);
    expect(result).toHaveLength(1);
    expect((result[0]!.parts[0] as { text: string }).text).toBe("v2");
  });

  it("preserves user messages (only assistants come from replay) — semantic check", () => {
    // The runtime contract: `session.out` contains assistant chunks only,
    // so `b` should never contain user messages. If it does (defensively),
    // the merge still works — but we lock down the typical pattern here.
    const a = [
      userMessage("u-1", "first"),
      assistantMessage("a-1", "stale"),
      userMessage("u-2", "second"),
    ];
    const b = [assistantMessage("a-1", "fresh")];
    const result = mergeByIdReplaceWins(a, b);
    // User messages from snapshot survive untouched.
    expect(result.filter((m) => m.role === "user").map((m) => m.id)).toEqual(["u-1", "u-2"]);
  });

  it("does not mutate either input array", () => {
    const a = [userMessage("u-1", "hi"), assistantMessage("a-1", "stale")];
    const b = [assistantMessage("a-1", "fresh"), userMessage("u-2", "next")];
    const aSnapshot = JSON.stringify(a);
    const bSnapshot = JSON.stringify(b);

    mergeByIdReplaceWins(a, b);

    expect(JSON.stringify(a)).toBe(aSnapshot);
    expect(JSON.stringify(b)).toBe(bSnapshot);
  });
});
