import type { UIMessage } from "ai";
import {
  emptyTranscriptState,
  reduceTranscriptChanges,
  type TranscriptChange,
  type TranscriptCursors,
  type TranscriptState,
  type TranscriptStorage,
  type TranscriptStorageContext,
} from "../transcriptStorage.js";

type TestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  expect: (actual: unknown) => {
    toEqual: (expected: unknown) => void;
    toBeNull: () => void;
    toBeUndefined: () => void;
    toBe: (expected: unknown) => void;
    toHaveLength: (length: number) => void;
  };
};

export type TranscriptStorageTestOptions = {
  /**
   * The test framework's `describe`, `it` and `expect`. Defaults to the
   * globals a vitest or jest run with `globals: true` provides.
   */
  api?: TestApi;
  /**
   * A chat id the storage accepts. Each test appends a suffix so tests do
   * not see each other's rows. Defaults to `"transcript-conformance"`.
   */
  chatId?: string;
  /** The `clientData` the storage expects in every scope and context. */
  clientData?: unknown;
};

function message(id: string, text: string, role: UIMessage["role"] = "user"): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

/**
 * The contract every `TranscriptStorage` has to meet, as a test suite. Point
 * it at a factory for your storage and run it under vitest or jest:
 *
 * ```ts
 * import { runTranscriptStorageTests } from "@trigger.dev/sdk/ai/test";
 * runTranscriptStorageTests(() => myTranscriptStorage(testDatabaseUrl));
 * ```
 *
 * The factory runs once per test. Return a fresh, empty storage, or one
 * whose chats are isolated by the `chatId` option.
 */
export function runTranscriptStorageTests<TClientData = unknown>(
  makeStorage: () => TranscriptStorage<TClientData> | Promise<TranscriptStorage<TClientData>>,
  options: TranscriptStorageTestOptions = {}
): void {
  const globals = globalThis as unknown as Partial<TestApi>;
  const api: TestApi = options.api ?? {
    describe: globals.describe!,
    it: globals.it!,
    expect: globals.expect!,
  };
  if (!api.describe || !api.it || !api.expect) {
    throw new Error(
      "runTranscriptStorageTests: no test API found. Enable `globals: true` in your test " +
        "config or pass `{ api: { describe, it, expect } }`."
    );
  }
  const { describe, it, expect } = api;
  const baseChatId = options.chatId ?? "transcript-conformance";
  const clientData = options.clientData as TClientData;

  const ctx = (chatId: string, turn = 0): TranscriptStorageContext<TClientData> => ({
    chatId,
    clientData,
    turn,
    trigger: "submit-message",
    runId: "run_conformance",
    ctx: {} as TranscriptStorageContext["ctx"],
  });
  const scope = (chatId: string) => ({ chatId, clientData });
  const ids = (messages: UIMessage[]) => messages.map((m) => m.id);

  const expected = new WeakMap<object, Map<string, TranscriptState>>();
  const save = async (
    storage: TranscriptStorage<TClientData>,
    context: TranscriptStorageContext<TClientData>,
    changeset: {
      reason: "turn-complete" | "turn-error" | "action";
      changes: TranscriptChange[];
      cursors?: TranscriptCursors;
    }
  ) => {
    let perChat = expected.get(storage);
    if (!perChat) {
      perChat = new Map();
      expected.set(storage, perChat);
    }
    const transcript = reduceTranscriptChanges(
      perChat.get(context.chatId) ?? emptyTranscriptState(),
      changeset.changes
    );
    perChat.set(context.chatId, transcript);
    await storage.save(context, { ...changeset, transcript });
  };

  describe("TranscriptStorage conformance", () => {
    it("loads an unknown chat as an empty transcript", async () => {
      const storage = await makeStorage();
      const loaded = await storage.load(scope(`${baseChatId}-empty`));
      expect(loaded.messages).toEqual([]);
      expect(loaded.state).toBeNull();
      expect(loaded.nextCursor).toBeUndefined();
    });

    it("appends puts in changeset order and replaces a known id in place", async () => {
      const storage = await makeStorage();
      const chatId = `${baseChatId}-put`;
      await save(storage, ctx(chatId), {
        reason: "turn-complete",
        changes: [
          { op: "put", message: message("u1", "one") },
          { op: "put", message: message("a1", "two", "assistant") },
          { op: "put", message: message("u2", "three") },
        ],
      });
      await save(storage, ctx(chatId, 1), {
        reason: "turn-complete",
        changes: [{ op: "put", message: message("a1", "two, edited", "assistant") }],
      });
      const loaded = await storage.load(scope(chatId));
      expect(ids(loaded.messages)).toEqual(["u1", "a1", "u2"]);
      expect(loaded.messages[1]).toEqual(message("a1", "two, edited", "assistant"));
    });

    it("removes by id and ignores an unknown id", async () => {
      const storage = await makeStorage();
      const chatId = `${baseChatId}-remove`;
      await save(storage, ctx(chatId), {
        reason: "turn-complete",
        changes: [
          { op: "put", message: message("u1", "one") },
          { op: "put", message: message("a1", "two", "assistant") },
          { op: "put", message: message("u2", "three") },
        ],
      });
      await save(storage, ctx(chatId, 1), {
        reason: "action",
        changes: [
          { op: "remove", id: "a1" },
          { op: "remove", id: "never-existed" },
        ],
      });
      expect(ids((await storage.load(scope(chatId))).messages)).toEqual(["u1", "u2"]);
    });

    it("truncates after an id and ignores an unknown id", async () => {
      const storage = await makeStorage();
      const chatId = `${baseChatId}-truncate`;
      await save(storage, ctx(chatId), {
        reason: "turn-complete",
        changes: ["u1", "a1", "u2", "a2"].map((id) => ({
          op: "put" as const,
          message: message(id, id),
        })),
      });
      await save(storage, ctx(chatId, 1), {
        reason: "action",
        changes: [{ op: "truncateAfter", afterId: "never-existed" }],
      });
      expect((await storage.load(scope(chatId))).messages).toHaveLength(4);
      await save(storage, ctx(chatId, 1), {
        reason: "action",
        changes: [{ op: "truncateAfter", afterId: "a1" }],
      });
      expect(ids((await storage.load(scope(chatId))).messages)).toEqual(["u1", "a1"]);
    });

    it("appends after a truncate at the end of the transcript", async () => {
      const storage = await makeStorage();
      const chatId = `${baseChatId}-truncate-append`;
      await save(storage, ctx(chatId), {
        reason: "turn-complete",
        changes: ["u1", "a1", "u2", "a2"].map((id) => ({
          op: "put" as const,
          message: message(id, id),
        })),
      });
      await save(storage, ctx(chatId, 1), {
        reason: "action",
        changes: [
          { op: "truncateAfter", afterId: "u2" },
          { op: "put", message: message("a2b", "regenerated", "assistant") },
        ],
      });
      expect(ids((await storage.load(scope(chatId))).messages)).toEqual(["u1", "a1", "u2", "a2b"]);
    });

    it("round-trips state and clears it with null", async () => {
      const storage = await makeStorage();
      const chatId = `${baseChatId}-state`;
      await save(storage, ctx(chatId), {
        reason: "turn-complete",
        changes: [
          { op: "put", message: message("u1", "one") },
          { op: "state", value: { v: 1, summary: "so far" } },
        ],
      });
      expect((await storage.load(scope(chatId))).state).toEqual({ v: 1, summary: "so far" });
      await save(storage, ctx(chatId, 1), {
        reason: "turn-complete",
        changes: [{ op: "put", message: message("u2", "two") }],
      });
      expect((await storage.load(scope(chatId))).state).toEqual({ v: 1, summary: "so far" });
      await save(storage, ctx(chatId, 2), {
        reason: "action",
        changes: [{ op: "state", value: null }],
      });
      expect((await storage.load(scope(chatId))).state).toBeNull();
    });

    it("keeps the latest cursors it was given", async () => {
      const storage = await makeStorage();
      const chatId = `${baseChatId}-cursors`;
      await save(storage, ctx(chatId), {
        reason: "turn-complete",
        changes: [{ op: "put", message: message("u1", "one") }],
        cursors: { lastOutEventId: "10", lastInEventId: "2" },
      });
      await save(storage, ctx(chatId, 1), {
        reason: "turn-complete",
        changes: [{ op: "put", message: message("u2", "two") }],
        cursors: { lastOutEventId: "20", lastInEventId: "4" },
      });
      const loaded = await storage.load(scope(chatId));
      expect(loaded.cursors?.lastOutEventId).toBe("20");
      expect(loaded.cursors?.lastInEventId).toBe("4");
    });

    it("keeps a partial answer's non-final status when the storage reports it", async () => {
      const storage = await makeStorage();
      const chatId = `${baseChatId}-final`;
      await save(storage, ctx(chatId), {
        reason: "turn-error",
        changes: [
          { op: "put", message: message("u1", "one") },
          { op: "put", message: message("a1", "partial", "assistant"), final: false },
        ],
      });

      const partial = await storage.load(scope(chatId));
      if (partial.nonFinalIds !== undefined) {
        expect(partial.nonFinalIds).toEqual(["a1"]);
      }

      await save(storage, ctx(chatId, 1), {
        reason: "turn-complete",
        changes: [{ op: "put", message: message("a1", "the finished answer", "assistant") }],
      });
      const finalized = await storage.load(scope(chatId));
      expect(ids(finalized.messages)).toEqual(["u1", "a1"]);
      if (finalized.nonFinalIds !== undefined) {
        expect(finalized.nonFinalIds).toEqual([]);
      }
    });

    it("converges when the same changeset is saved twice", async () => {
      const storage = await makeStorage();
      const chatId = `${baseChatId}-replay`;
      const changeset = {
        reason: "turn-complete" as const,
        changes: [
          { op: "put" as const, message: message("u1", "one") },
          { op: "put" as const, message: message("a1", "two", "assistant") },
          { op: "state" as const, value: { v: 1 } },
        ],
        cursors: { lastOutEventId: "7" },
      };
      await save(storage, ctx(chatId), changeset);
      await save(storage, ctx(chatId), changeset);
      const loaded = await storage.load(scope(chatId));
      expect(ids(loaded.messages)).toEqual(["u1", "a1"]);
      expect(loaded.state).toEqual({ v: 1 });
    });

    it("pages from the most recent message backwards with limit and before", async () => {
      const storage = await makeStorage();
      const chatId = `${baseChatId}-paging`;
      await save(storage, ctx(chatId), {
        reason: "turn-complete",
        changes: ["m1", "m2", "m3", "m4", "m5"].map((id) => ({
          op: "put" as const,
          message: message(id, id),
        })),
      });
      const last = await storage.load(scope(chatId), { limit: 2 });
      expect(ids(last.messages)).toEqual(["m4", "m5"]);
      expect(last.nextCursor).toBe("m4");
      const middle = await storage.load(scope(chatId), { limit: 2, before: last.nextCursor });
      expect(ids(middle.messages)).toEqual(["m2", "m3"]);
      expect(middle.nextCursor).toBe("m2");
      const first = await storage.load(scope(chatId), { limit: 2, before: middle.nextCursor });
      expect(ids(first.messages)).toEqual(["m1"]);
      expect(first.nextCursor).toBeUndefined();
    });

    it("keeps chats apart", async () => {
      const storage = await makeStorage();
      await save(storage, ctx(`${baseChatId}-a`), {
        reason: "turn-complete",
        changes: [{ op: "put", message: message("u1", "in a") }],
      });
      await save(storage, ctx(`${baseChatId}-b`), {
        reason: "turn-complete",
        changes: [{ op: "put", message: message("u1", "in b") }],
      });
      expect((await storage.load(scope(`${baseChatId}-a`))).messages[0]).toEqual(
        message("u1", "in a")
      );
      expect((await storage.load(scope(`${baseChatId}-b`))).messages[0]).toEqual(
        message("u1", "in b")
      );
    });
  });
}
