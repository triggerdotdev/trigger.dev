import "../src/v3/test/index.js";

import type { TranscriptSnapshotV2 } from "@trigger.dev/core/v3";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setReadChatSnapshotImplForTests,
  __setWriteChatSnapshotImplForTests,
} from "../src/v3/chatSnapshotIo.js";
import {
  createTranscriptShadow,
  diffTranscript,
  emptyTranscriptState,
  reduceTranscriptChanges,
  snapshotTranscriptStorage,
  type TranscriptChange,
  type TranscriptStorageContext,
} from "../src/v3/transcriptStorage.js";

const msg = (id: string, text: string, role: UIMessage["role"] = "user"): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
});

const u1 = msg("u-1", "hi");
const a1 = msg("a-1", "hello", "assistant");
const u2 = msg("u-2", "more");
const a2 = msg("a-2", "sure", "assistant");

function applyDiff(prev: UIMessage[], next: UIMessage[], nonFinalIds?: Set<string>) {
  const shadow = createTranscriptShadow(prev);
  const { changes, shadow: nextShadow } = diffTranscript(shadow, next, { nonFinalIds });
  const state = reduceTranscriptChanges(
    reduceTranscriptChanges(
      emptyTranscriptState(),
      prev.map((m) => ({ op: "put", message: m }))
    ),
    changes
  );
  return { changes, state, nextShadow };
}

describe("reduceTranscriptChanges", () => {
  it("appends an unknown id and replaces a known id in place", () => {
    const s1 = reduceTranscriptChanges(emptyTranscriptState(), [
      { op: "put", message: u1 },
      { op: "put", message: a1 },
    ]);
    const edited = msg("u-1", "hi (edited)");
    const s2 = reduceTranscriptChanges(s1, [{ op: "put", message: edited }]);

    expect(s2.entries.map((e) => e.id)).toEqual(["u-1", "a-1"]);
    expect(s2.entries[0]!.message).toEqual(edited);
    expect(s2.entries.every((e) => e.final)).toBe(true);
    expect(s1.entries[0]!.message).toEqual(u1);
  });

  it("records final: false from a put and defaults to true", () => {
    const s = reduceTranscriptChanges(emptyTranscriptState(), [
      { op: "put", message: u1 },
      { op: "put", message: a1, final: false },
    ]);
    expect(s.entries.map((e) => e.final)).toEqual([true, false]);
  });

  it("removes by id, truncates after an id, and sets state; unknown ids are no-ops", () => {
    const base = reduceTranscriptChanges(emptyTranscriptState(), [
      { op: "put", message: u1 },
      { op: "put", message: a1 },
      { op: "put", message: u2 },
      { op: "put", message: a2 },
    ]);

    const removed = reduceTranscriptChanges(base, [{ op: "remove", id: "a-1" }]);
    expect(removed.entries.map((e) => e.id)).toEqual(["u-1", "u-2", "a-2"]);

    const truncated = reduceTranscriptChanges(base, [{ op: "truncateAfter", afterId: "a-1" }]);
    expect(truncated.entries.map((e) => e.id)).toEqual(["u-1", "a-1"]);

    const noop = reduceTranscriptChanges(base, [
      { op: "remove", id: "nope" },
      { op: "truncateAfter", afterId: "nope" },
    ]);
    expect(noop.entries).toEqual(base.entries);

    const withState = reduceTranscriptChanges(base, [{ op: "state", value: { summary: "s" } }]);
    expect(withState.state).toEqual({ summary: "s" });
    expect(reduceTranscriptChanges(withState, [{ op: "state", value: null }]).state).toBeNull();
  });

  it("converges when the same changes are applied twice", () => {
    const changes: TranscriptChange[] = [
      { op: "put", message: u1 },
      { op: "put", message: a1 },
      { op: "truncateAfter", afterId: "u-1" },
      { op: "put", message: msg("a-1b", "again", "assistant") },
      { op: "remove", id: "u-1" },
    ];
    const once = reduceTranscriptChanges(emptyTranscriptState(), changes);
    const twice = reduceTranscriptChanges(once, changes);
    expect(twice).toEqual(once);
  });
});

describe("diffTranscript", () => {
  it("emits puts for appended messages", () => {
    const { changes, state } = applyDiff([u1, a1], [u1, a1, u2, a2]);
    expect(changes).toEqual([
      { op: "put", message: u2 },
      { op: "put", message: a2 },
    ]);
    expect(state.entries.map((e) => e.message)).toEqual([u1, a1, u2, a2]);
  });

  it("emits an in-place put for a changed message with the same id", () => {
    const a1Grown = msg("a-1", "hello there", "assistant");
    const { changes, state } = applyDiff([u1, a1], [u1, a1Grown]);
    expect(changes).toEqual([{ op: "put", message: a1Grown }]);
    expect(state.entries.map((e) => e.message)).toEqual([u1, a1Grown]);
  });

  it("emits nothing when nothing changed", () => {
    const { changes } = applyDiff([u1, a1], [structuredClone(u1), structuredClone(a1)]);
    expect(changes).toEqual([]);
  });

  it("expresses an undo as one truncateAfter", () => {
    const { changes, state } = applyDiff([u1, a1, u2, a2], [u1, a1]);
    expect(changes).toEqual([{ op: "truncateAfter", afterId: "a-1" }]);
    expect(state.entries.map((e) => e.id)).toEqual(["u-1", "a-1"]);
  });

  it("expresses a regenerate as truncateAfter plus a put", () => {
    const a2b = msg("a-2b", "better", "assistant");
    const { changes, state } = applyDiff([u1, a1, u2, a2], [u1, a1, u2, a2b]);
    expect(changes).toEqual([
      { op: "truncateAfter", afterId: "u-2" },
      { op: "put", message: a2b },
    ]);
    expect(state.entries.map((e) => e.id)).toEqual(["u-1", "a-1", "u-2", "a-2b"]);
  });

  it("removes everything when there is no common prefix, then puts the new list", () => {
    const { changes, state } = applyDiff([u1, a1], [u2, a2]);
    expect(changes).toEqual([
      { op: "remove", id: "u-1" },
      { op: "remove", id: "a-1" },
      { op: "put", message: u2 },
      { op: "put", message: a2 },
    ]);
    expect(state.entries.map((e) => e.id)).toEqual(["u-2", "a-2"]);
  });

  it("reproduces an arbitrary reorder exactly", () => {
    const { state } = applyDiff([u1, a1, u2, a2], [u1, u2, a1, a2]);
    expect(state.entries.map((e) => e.id)).toEqual(["u-1", "u-2", "a-1", "a-2"]);
  });

  it("marks the ids in nonFinalIds as final: false", () => {
    const { changes } = applyDiff([u1], [u1, a1], new Set(["a-1"]));
    expect(changes).toEqual([{ op: "put", message: a1, final: false }]);
  });

  it("returns a shadow that makes the next diff incremental", () => {
    const first = applyDiff([], [u1, a1]);
    const { changes } = diffTranscript(first.nextShadow, [u1, a1, u2]);
    expect(changes).toEqual([{ op: "put", message: u2 }]);
  });
});

describe("snapshotTranscriptStorage", () => {
  const ctx = (chatId: string): TranscriptStorageContext<unknown> => ({
    chatId,
    clientData: undefined,
    turn: 0,
    trigger: "submit-message",
    runId: "run_1",
    ctx: {} as TranscriptStorageContext["ctx"],
  });

  let stored: TranscriptSnapshotV2 | undefined;
  let reads = 0;
  let writes: TranscriptSnapshotV2[] = [];

  function install(initial: unknown) {
    stored = undefined;
    reads = 0;
    writes = [];
    __setReadChatSnapshotImplForTests(() => {
      reads++;
      return initial;
    });
    __setWriteChatSnapshotImplForTests((_id, snapshot) => {
      stored = snapshot as TranscriptSnapshotV2;
      writes.push(stored);
    });
  }

  afterEach(() => {
    __setReadChatSnapshotImplForTests(undefined);
    __setWriteChatSnapshotImplForTests(undefined);
  });

  it("loads a version 1 blob as messages plus cursors with null state", async () => {
    install({
      version: 1,
      savedAt: 5,
      messages: [u1, a1],
      lastOutEventId: "9",
      lastInEventId: "3",
    });
    const storage = snapshotTranscriptStorage();
    const loaded = await storage.load({ chatId: "c1", clientData: undefined });

    expect(loaded.messages).toEqual([u1, a1]);
    expect(loaded.state).toBeNull();
    expect(loaded.cursors).toEqual({ lastOutEventId: "9", lastInEventId: "3" });
    expect(loaded.nextCursor).toBeUndefined();
  });

  it("loads with no snapshot as an empty transcript and no cursors", async () => {
    install(undefined);
    const storage = snapshotTranscriptStorage();
    const loaded = await storage.load({ chatId: "c1", clientData: undefined });
    expect(loaded).toEqual({
      messages: [],
      state: null,
      cursors: undefined,
      nextCursor: undefined,
    });
  });

  it("pages from the most recent message backwards with limit and before", async () => {
    install({
      version: 2,
      savedAt: 5,
      messages: [u1, a1, u2, a2].map((m) => ({ id: m.id, final: true, message: m })),
      state: null,
    });
    const storage = snapshotTranscriptStorage();

    const last = await storage.load({ chatId: "c1", clientData: undefined }, { limit: 2 });
    expect(last.messages.map((m) => m.id)).toEqual(["u-2", "a-2"]);
    expect(last.nextCursor).toBe("u-2");

    const prev = await storage.load(
      { chatId: "c1", clientData: undefined },
      { limit: 2, before: last.nextCursor }
    );
    expect(prev.messages.map((m) => m.id)).toEqual(["u-1", "a-1"]);
    expect(prev.nextCursor).toBeUndefined();
  });

  it("saves by reducing onto the loaded transcript and writes one version 2 blob per save with no re-read", async () => {
    install({ version: 1, savedAt: 5, messages: [u1, a1], lastOutEventId: "9" });
    const storage = snapshotTranscriptStorage();
    await storage.load({ chatId: "c1", clientData: undefined });

    await storage.save(ctx("c1"), {
      reason: "turn-complete",
      changes: [
        { op: "put", message: u2 },
        { op: "put", message: a2, final: false },
        { op: "state", value: { summary: "s" } },
      ],
      cursors: { lastOutEventId: "12", lastInEventId: "4" },
    });

    expect(reads).toBe(1);
    expect(writes).toHaveLength(1);
    expect(stored).toMatchObject({
      version: 2,
      messages: [
        { id: "u-1", final: true, message: u1 },
        { id: "a-1", final: true, message: a1 },
        { id: "u-2", final: true, message: u2 },
        { id: "a-2", final: false, message: a2 },
      ],
      state: { summary: "s" },
      lastOutEventId: "12",
      lastInEventId: "4",
    });
    expect(typeof stored!.savedAt).toBe("number");

    await storage.save(ctx("c1"), {
      reason: "action",
      changes: [{ op: "truncateAfter", afterId: "a-1" }],
      cursors: { lastOutEventId: "12", lastInEventId: "4" },
    });
    expect(reads).toBe(1);
    expect(stored!.messages.map((e) => e.id)).toEqual(["u-1", "a-1"]);
    expect(stored!.state).toEqual({ summary: "s" });
  });

  it("saves without a prior load starting from an empty transcript", async () => {
    install(undefined);
    const storage = snapshotTranscriptStorage();
    await storage.save(ctx("fresh"), {
      reason: "turn-complete",
      changes: [{ op: "put", message: u1 }],
      cursors: { lastOutEventId: "1" },
    });
    expect(reads).toBe(0);
    expect(stored!.messages.map((e) => e.id)).toEqual(["u-1"]);
    expect(stored!.lastOutEventId).toBe("1");
    expect(stored!.lastInEventId).toBeUndefined();
  });
});
