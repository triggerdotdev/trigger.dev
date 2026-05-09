import type { UIMessage, UIMessageChunk } from "ai";
import { resourceCatalog } from "@trigger.dev/core/v3";
import type { LocalsKey } from "@trigger.dev/core/v3";
import {
  runInMockTaskContext,
  type MockTaskContextOptions,
} from "@trigger.dev/core/v3/test";
import {
  __setSessionOpenImplForTests,
  __setSessionStartImplForTests,
} from "../sessions.js";
import {
  __setReadChatSnapshotImplForTests,
  __setReplaySessionOutTailImplForTests,
  __setWriteChatSnapshotImplForTests,
  type ChatSnapshotV1,
} from "../ai.js";
import {
  createTestSessionHandle,
  type TestSessionOutState,
} from "./test-session-handle.js";

/** Pre-seed locals before the agent's `run()` starts. */
export type SetupLocals = (locals: {
  set<T>(key: LocalsKey<T>, value: T): void;
}) => void | Promise<void>;

// The slim wire payload shape used by chat.agent tasks. Kept loose here so we
// don't import from the backend-only ai.ts module. At most ONE message per
// record — runtime rebuilds prior history from snapshot + replay at boot.
type ChatWirePayload = {
  /** At most one message — singular under the slim wire. Set on submit-message. */
  message?: UIMessage;
  /** Bespoke escape hatch — only set on `trigger: "handover-prepare"`. */
  headStartMessages?: UIMessage[];
  chatId: string;
  trigger:
    | "submit-message"
    | "regenerate-message"
    | "preload"
    | "close"
    | "action"
    | "handover-prepare";
  messageId?: string;
  metadata?: unknown;
  action?: unknown;
  continuation?: boolean;
  previousRunId?: string;
  idleTimeoutInSeconds?: number;
  sessionId?: string;
};

/** A reference to a `chat.agent` task returned by `chat.agent({ id, ... })`. */
type ChatAgentHandle = { id: string };

/**
 * Options for `mockChatAgent`.
 */
export type MockChatAgentOptions = {
  /** The chat session id passed into every wire payload. Defaults to `"test-chat"`. */
  chatId?: string;
  /** Client-provided metadata (`clientData`) for the session. */
  clientData?: unknown;
  /** Task context overrides passed through to {@link runInMockTaskContext}. */
  taskContext?: MockTaskContextOptions;
  /**
   * Whether to start the task in preload mode. Defaults to `true` so the
   * first `sendMessage()` triggers the first turn via the preload path.
   * Set to `false` to skip preload — the first `sendMessage()` starts turn 0 directly.
   *
   * Ignored when `mode: "handover-prepare"` is set.
   */
  preload?: boolean;
  /**
   * Initial trigger the agent boots with. Defaults to `"preload"` (or
   * `"submit-message"` when `preload: false`). Use `"handover-prepare"`
   * to drive the chat.handover wait branch — call `sendHandover()` /
   * `sendHandoverSkip()` to dispatch the handover signal.
   */
  mode?: "preload" | "submit-message" | "handover-prepare";
  /**
   * Pre-seed the snapshot the agent reads at run boot. The runtime's
   * snapshot read is replaced with one that returns this snapshot
   * (skipping the real S3 GET). Use to drive boot scenarios — fresh
   * boot with prior history, OOM-retry boot with stale snapshot, etc.
   * Pass `undefined` (the default) to start with no snapshot.
   *
   * See plan section B.3 for the boot orchestration spec.
   */
  snapshot?: ChatSnapshotV1;
  /**
   * Callback that runs **before** the agent's `run()` is invoked, with a
   * `set` function for pre-seeding locals. Use this to inject server-side
   * dependencies (database clients, service stubs) that the agent reads
   * via `locals.get()` in its hooks.
   *
   * @example
   * ```ts
   * import { dbKey } from "./db";
   *
   * const harness = mockChatAgent(agent, {
   *   chatId: "test-1",
   *   setupLocals: (locals) => {
   *     locals.set(dbKey, testDb);
   *   },
   * });
   * ```
   */
  setupLocals?: SetupLocals;
};

/**
 * Result of a single turn, returned by driver methods like `sendMessage()`.
 */
export type MockChatAgentTurn = {
  /** UIMessageChunks emitted during this turn (excludes control chunks like turn-complete). */
  chunks: UIMessageChunk[];
  /** All raw chunks including control chunks (turn-complete, upgrade-required, etc.). */
  rawChunks: unknown[];
};

/**
 * Harness returned by `mockChatAgent`. Drives a `chat.agent` task end-to-end
 * without network or task runtime.
 */
export type MockChatAgentHarness = {
  /** The chat session id used by this harness. */
  readonly chatId: string;

  /**
   * Send a single user message (or tool-approval-responded assistant
   * message) and wait for the next turn-complete. Returns the chunks
   * produced during this turn.
   *
   * Slim wire: at most ONE message per send. The agent reconstructs prior
   * history from snapshot + session.out replay at run boot.
   */
  sendMessage(message: UIMessage): Promise<MockChatAgentTurn>;

  /**
   * Send a regenerate signal (no message body — slim wire). The agent
   * trims trailing assistant messages from its in-memory accumulator and
   * re-runs. Waits for turn-complete.
   */
  sendRegenerate(): Promise<MockChatAgentTurn>;

  /**
   * Drive the head-start path: sends `trigger: "handover-prepare"` with
   * `headStartMessages` carrying the first-turn UIMessage history. Used
   * only at the very first turn before any snapshot exists. The route
   * handler ships full UIMessage history through this path because the
   * customer's HTTP endpoint isn't subject to the `/in/append` cap.
   */
  sendHeadStart(args: { messages: UIMessage[] }): Promise<MockChatAgentTurn>;

  /** Send a custom action and wait for the next turn-complete. */
  sendAction(action: unknown): Promise<MockChatAgentTurn>;

  /** Fire a stop signal. Does not wait for the turn — the task keeps running. */
  sendStop(message?: string): Promise<void>;

  /**
   * Dispatch a `handover` signal — the agent picks up partial assistant
   * messages and continues the turn. Only meaningful when the harness
   * was started with `mode: "handover-prepare"`. Waits for turn-complete.
   *
   * `isFinal: false` (default) — agent runs `streamText` which executes
   * any pending tool-calls (via the approval round) and resumes from
   * step 2.
   *
   * `isFinal: true` — agent runs lifecycle hooks but skips `streamText`.
   * The partial IS the response; `onTurnComplete` fires with it.
   */
  sendHandover(args: {
    partialAssistantMessage: unknown[];
    isFinal?: boolean;
    messageId?: string;
  }): Promise<MockChatAgentTurn>;

  /**
   * Dispatch a `handover-skip` signal — the agent exits cleanly without
   * firing turn hooks. Only meaningful when the harness was started
   * with `mode: "handover-prepare"`. Awaits the run finishing.
   */
  sendHandoverSkip(): Promise<void>;

  /**
   * Pre-seed the snapshot read for the next boot. The runtime's snapshot
   * read returns this snapshot (skipping S3). Pass `undefined` to clear —
   * the boot then sees no snapshot and falls through to replay-only.
   *
   * Effective on the next run boot only. Calling mid-turn is a no-op
   * because the snapshot read happens once at run boot.
   */
  seedSnapshot(snapshot: ChatSnapshotV1 | undefined): void;

  /**
   * Pre-seed `session.out` chunks for the next boot's replay. The runtime's
   * `replaySessionOutTail` returns whatever the synthetic chunks reduce
   * to. Pass `[]` to clear (boot replay returns no messages).
   *
   * Requires `__setReplaySessionOutTailImplForTests` exported from
   * `ai.ts`. The harness throws a clear error at call time if that hook
   * isn't available.
   */
  seedSessionOutTail(chunks?: UIMessageChunk[]): void;

  /**
   * The most recently written snapshot, or `undefined` if no snapshot
   * has been written yet. Updated each time `writeChatSnapshot` is
   * invoked from the run loop's snapshot-write site (plan section B.6).
   */
  getSnapshot(): ChatSnapshotV1 | undefined;

  /**
   * Close the chat session cleanly. Sends `trigger: "close"` and awaits the
   * task's `run()` function returning. Call this at the end of every test
   * (or use `await using`) so the background task isn't left dangling.
   */
  close(): Promise<void>;

  /** All UIMessageChunks emitted since the harness was created. */
  readonly allChunks: UIMessageChunk[];

  /** Every raw chunk (including control chunks) emitted since the harness was created. */
  readonly allRawChunks: unknown[];
};

const CONTROL_CHUNK_TYPES = new Set([
  "trigger:turn-complete",
  "trigger:upgrade-required",
]);

function isControlChunk(chunk: unknown): boolean {
  if (typeof chunk !== "object" || chunk === null) return false;
  const type = (chunk as { type?: string }).type;
  return typeof type === "string" && CONTROL_CHUNK_TYPES.has(type);
}

/**
 * Create an offline test harness for a `chat.agent` task.
 *
 * The harness starts the agent's `run()` function in a mocked task context,
 * waits in preload for the first message, then exposes driver methods for
 * sending messages / actions / stop signals and awaiting turn completion.
 *
 * Users are responsible for mocking the language model themselves — use
 * `MockLanguageModelV3` and `simulateReadableStream` from `ai/test` inside
 * their agent's `run()` function (typically via DI through `clientData`).
 *
 * @example
 * ```ts
 * import { mockChatAgent } from "@trigger.dev/sdk/ai/test";
 * import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
 * import { myAgent } from "./my-agent";
 *
 * test("says hello", async () => {
 *   const harness = mockChatAgent(myAgent, { chatId: "test-1" });
 *   try {
 *     const turn = await harness.sendMessage({
 *       id: "m1",
 *       role: "user",
 *       parts: [{ type: "text", text: "hi" }],
 *     });
 *     expect(turn.chunks).toContainEqual(
 *       expect.objectContaining({ type: "text-delta", delta: "hello" })
 *     );
 *   } finally {
 *     await harness.close();
 *   }
 * });
 * ```
 */
export function mockChatAgent(
  agent: ChatAgentHandle,
  options: MockChatAgentOptions = {}
): MockChatAgentHarness {
  const chatId = options.chatId ?? "test-chat";
  // The agent opens the session with `payload.sessionId ?? payload.chatId`.
  // We pass no sessionId, so it falls back to chatId.
  const sessionId = chatId;
  const mode: "preload" | "submit-message" | "handover-prepare" =
    options.mode ?? (options.preload === false ? "submit-message" : "preload");
  const clientData = options.clientData;

  const taskEntry = resourceCatalog.getTask(agent.id);
  if (!taskEntry) {
    throw new Error(
      `mockChatAgent: no task registered with id "${agent.id}". ` +
        `Import "@trigger.dev/sdk/ai/test" before your agent module so tasks register correctly.`
    );
  }

  const runFn = taskEntry.fns.run;

  // Session .out state: chunks + listener registry. Shared between the
  // harness and the TestSessionOutputChannel installed via the open-override.
  const sessionOutState: TestSessionOutState = {
    chunks: [],
    listeners: new Set(),
  };

  // Buffers that survive across harness method calls
  const allRawChunks: unknown[] = [];
  const allChunks: UIMessageChunk[] = [];

  // Promise that resolves when the background task run() function returns.
  let taskFinished!: Promise<void>;
  let sendSessionInput!: (sessionId: string, data: unknown) => Promise<void>;
  let closeSessionInput: ((sessionId: string) => void) | undefined;
  let runSignal!: AbortController;

  // A latch that resolves every time `trigger:turn-complete` appears on the chat stream.
  // We use a shared pending promise and replace it after each completion.
  let turnCompleteResolvers: Array<() => void> = [];
  const waitForTurnComplete = () =>
    new Promise<void>((resolve) => {
      turnCompleteResolvers.push(resolve);
    });

  // Signal that the caller is ready to observe output
  let harnessReadyResolve!: () => void;
  const harnessReady = new Promise<void>((resolve) => {
    harnessReadyResolve = resolve;
  });

  // ── Snapshot read/write override state ───────────────────────────────
  // The runtime's snapshot read returns whatever `seededSnapshot` is at
  // boot time. The runtime's snapshot write captures into
  // `lastWrittenSnapshot` for harness consumers to assert via
  // `getSnapshot()`. Installed below alongside the session overrides;
  // cleared on close in the same finally block.
  let seededSnapshot: ChatSnapshotV1 | undefined = options.snapshot;
  let lastWrittenSnapshot: ChatSnapshotV1 | undefined;
  let seededReplayChunks: UIMessageChunk[] = [];

  __setReadChatSnapshotImplForTests(<T extends UIMessage>(_id: string) => {
    return seededSnapshot as ChatSnapshotV1<T> | undefined;
  });
  __setWriteChatSnapshotImplForTests(<T extends UIMessage>(_id: string, snapshot: ChatSnapshotV1<T>) => {
    lastWrittenSnapshot = snapshot as ChatSnapshotV1;
  });

  // Replay override: install a default that returns whatever
  // `seededReplayChunks` reduces to. Cleared in the same `finally` block
  // as the other test overrides.
  __setReplaySessionOutTailImplForTests(async () => {
    if (seededReplayChunks.length === 0) return [];
    return (await reduceChunksToMessages(seededReplayChunks)) as never;
  });

  // Install the session open override so `sessions.open(id)` returns a
  // SessionHandle with an in-memory `.out` that captures writes. The
  // `.in` channel routes record subscriptions (`on`/`once`/`peek`)
  // through the `sessionStreams` global — the mock task context
  // installs a `TestSessionStreamManager` there — and stubs `wait()`
  // so the suspend path resolves cleanly on `runSignal.abort()` without
  // touching the api client.
  __setSessionOpenImplForTests((id) =>
    createTestSessionHandle(id, sessionOutState, () => runSignal?.signal)
  );

  // Install the session start override so any test path that invokes
  // `sessions.start()` (typically through a server action shim like
  // `chat.createStartSessionAction`) becomes a no-op fixture instead of
  // hitting a real API. Most chat.agent tests trigger the run directly
  // via `sendPayloadAndWait` and never go through this path, but the
  // stub keeps the API safe to call from inside tested code.
  __setSessionStartImplForTests((body) => {
    if (process.env.TRIGGER_CHAT_TEST_DEBUG === "1") {
      console.log("[mockChatAgent] sessions.start override:", body);
    }
    const fakeRunId = `run_test_${body.externalId ?? "anon"}`;
    return {
      id: `session_test_${body.externalId ?? "anon"}`,
      externalId: body.externalId ?? null,
      type: body.type,
      taskIdentifier: body.taskIdentifier,
      triggerConfig: body.triggerConfig,
      currentRunId: fakeRunId,
      runId: fakeRunId,
      publicAccessToken: "tr_test_session_pat",
      tags: body.tags ?? [],
      metadata: (body.metadata ?? null) as Record<string, unknown> | null,
      closedAt: null,
      closedReason: null,
      expiresAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      isCached: false,
    };
  });

  taskFinished = runInMockTaskContext(
    async (drivers) => {
      runSignal = new AbortController();

      const initialPayload: ChatWirePayload = {
        chatId,
        trigger: mode,
        metadata: clientData,
      };

      sendSessionInput = drivers.sessions.in.send;
      closeSessionInput = drivers.sessions.in.close;

      // Record every chunk written to session.out, detect turn-complete.
      const listener = (chunk: unknown) => {
        allRawChunks.push(chunk);
        if (!isControlChunk(chunk)) {
          allChunks.push(chunk as UIMessageChunk);
        }
        if (
          typeof chunk === "object" &&
          chunk !== null &&
          (chunk as { type?: string }).type === "trigger:turn-complete"
        ) {
          const resolvers = turnCompleteResolvers;
          turnCompleteResolvers = [];
          for (const resolve of resolvers) resolve();
        }
      };
      sessionOutState.listeners.add(listener);
      const unsubscribe = () => sessionOutState.listeners.delete(listener);

      if (options.setupLocals) {
        await options.setupLocals({ set: drivers.locals.set });
      }

      harnessReadyResolve();

      try {
        if (process.env.TRIGGER_CHAT_TEST_DEBUG === "1") {
          console.log("[mockChatAgent] Starting runFn with payload:", initialPayload);
        }
        await runFn(initialPayload, {
          ctx: drivers.ctx,
          signal: runSignal.signal,
        });
        if (process.env.TRIGGER_CHAT_TEST_DEBUG === "1") {
          console.log("[mockChatAgent] runFn returned");
        }
      } catch (err) {
        if (process.env.TRIGGER_CHAT_TEST_DEBUG === "1") {
          console.log("[mockChatAgent] runFn threw:", err);
        }
        throw err;
      } finally {
        unsubscribe();
        // Resolve any outstanding turn-complete waiters so callers don't hang
        const resolvers = turnCompleteResolvers;
        turnCompleteResolvers = [];
        for (const resolve of resolvers) resolve();
      }
    },
    options.taskContext
  )
    .catch((err) => {
      // Propagate errors to pending turn waiters instead of dropping them
      const resolvers = turnCompleteResolvers;
      turnCompleteResolvers = [];
      for (const resolve of resolvers) resolve();
      throw err;
    })
    .finally(() => {
      // Always clear the test overrides, even if the task threw.
      __setSessionOpenImplForTests(undefined);
      __setSessionStartImplForTests(undefined);
      __setReadChatSnapshotImplForTests(undefined);
      __setWriteChatSnapshotImplForTests(undefined);
      __setReplaySessionOutTailImplForTests(undefined);
    });

  const sendPayloadAndWait = async (
    payload: ChatWirePayload
  ): Promise<MockChatAgentTurn> => {
    await harnessReady;
    const before = allRawChunks.length;
    const turnComplete = waitForTurnComplete();
    await sendSessionInput(sessionId, { kind: "message", payload });
    await turnComplete;
    const rawChunks = allRawChunks.slice(before);
    const chunks = rawChunks.filter(
      (c) => !isControlChunk(c)
    ) as UIMessageChunk[];
    return { chunks, rawChunks };
  };

  const harness: MockChatAgentHarness = {
    chatId,

    async sendMessage(message) {
      return sendPayloadAndWait({
        message,
        chatId,
        trigger: "submit-message",
        metadata: clientData,
      });
    },

    async sendRegenerate() {
      return sendPayloadAndWait({
        chatId,
        trigger: "regenerate-message",
        metadata: clientData,
      });
    },

    async sendHeadStart({ messages }) {
      return sendPayloadAndWait({
        headStartMessages: messages,
        chatId,
        trigger: "handover-prepare",
        metadata: clientData,
      });
    },

    async sendAction(action) {
      return sendPayloadAndWait({
        chatId,
        trigger: "action",
        action,
        metadata: clientData,
      });
    },

    async sendStop(message) {
      await harnessReady;
      await sendSessionInput(sessionId, { kind: "stop", message });
    },

    async sendHandover(args) {
      await harnessReady;
      const before = allRawChunks.length;
      const turnComplete = waitForTurnComplete();
      await sendSessionInput(sessionId, {
        kind: "handover",
        partialAssistantMessage: args.partialAssistantMessage,
        messageId: args.messageId,
        isFinal: args.isFinal ?? false,
      });
      await turnComplete;
      const rawChunks = allRawChunks.slice(before);
      const chunks = rawChunks.filter((c) => !isControlChunk(c)) as UIMessageChunk[];
      return { chunks, rawChunks };
    },

    async sendHandoverSkip() {
      await harnessReady;
      // No turn-complete on skip — the agent exits without firing hooks.
      // Send the chunk and wait for the run to finish.
      await sendSessionInput(sessionId, { kind: "handover-skip" });
      await Promise.race([
        taskFinished.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    },

    seedSnapshot(snapshot) {
      seededSnapshot = snapshot;
    },

    seedSessionOutTail(chunks) {
      seededReplayChunks = chunks ?? [];
    },

    getSnapshot() {
      return lastWrittenSnapshot;
    },

    async close() {
      await harnessReady;

      // Send a close trigger wrapped as a `kind: "message"` ChatInputChunk.
      // The turn loop checks for this after a successful turn and exits
      // cleanly. On error-recovery paths the loop just loops back with
      // the close payload, so we also close the session input below to
      // unblock any pending once() waiters.
      try {
        await sendSessionInput(sessionId, {
          kind: "message",
          payload: {
            chatId,
            trigger: "close",
          },
        });
      } catch {
        // best-effort
      }
      // Resolve any pending once() waiters on the session input with a
      // timeout error — that makes waitWithIdleTimeout return
      // `{ ok: false }` and the turn loop exits cleanly.
      closeSessionInput?.(sessionId);

      // Also abort the run signal so anything downstream (streamText,
      // deferred work) unwinds promptly.
      runSignal?.abort("close");

      // Wait for run() to return. The loop's error recovery path will
      // see !next.ok and exit. Use a bounded wait so tests never hang.
      await Promise.race([
        taskFinished.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    },

    get allChunks() {
      return allChunks.slice();
    },

    get allRawChunks() {
      return allRawChunks.slice();
    },
  };

  return harness;
}

/**
 * Reduce a synthetic UIMessageChunk[] sequence into the UIMessage[] that
 * the runtime's `replaySessionOutTail` would produce. Splits chunks at
 * `start` boundaries and feeds each segment through AI SDK's
 * `readUIMessageStream`. The trailing un-finished segment goes through
 * `cleanupAbortedParts`. Mirrors the production reducer used in
 * `ai.ts:replaySessionOutTail`.
 */
async function reduceChunksToMessages(chunks: UIMessageChunk[]): Promise<UIMessage[]> {
  if (chunks.length === 0) return [];
  const aiModule = (await import("ai")) as {
    readUIMessageStream?: (args: { stream: ReadableStream<UIMessageChunk> }) => AsyncIterable<UIMessage>;
    cleanupAbortedParts?: (msg: UIMessage) => UIMessage;
  };
  const readUIMessageStream = aiModule.readUIMessageStream;
  const cleanupAbortedParts = aiModule.cleanupAbortedParts;
  if (!readUIMessageStream) return [];

  type Segment = { chunks: UIMessageChunk[]; closed: boolean };
  const segments: Segment[] = [];
  let current: Segment | undefined;
  for (const chunk of chunks) {
    if (chunk.type === "start") {
      current = { chunks: [chunk], closed: false };
      segments.push(current);
      continue;
    }
    if (!current) {
      current = { chunks: [], closed: false };
      segments.push(current);
    }
    current.chunks.push(chunk);
    if (chunk.type === "finish") {
      current.closed = true;
      current = undefined;
    }
  }

  const out: UIMessage[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isTrailing = i === segments.length - 1 && !seg.closed;
    const segmentStream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const c of seg.chunks) controller.enqueue(c);
        controller.close();
      },
    });
    let last: UIMessage | undefined;
    try {
      for await (const snapshot of readUIMessageStream({ stream: segmentStream })) {
        last = snapshot;
      }
    } catch {
      // Skip malformed segment — tests can assert by inspecting what makes it through.
      continue;
    }
    if (!last) continue;
    if (isTrailing && cleanupAbortedParts) {
      const cleaned = cleanupAbortedParts(last);
      if (!cleaned.parts || cleaned.parts.length === 0) continue;
      out.push(cleaned);
    } else {
      out.push(last);
    }
  }
  return out;
}
