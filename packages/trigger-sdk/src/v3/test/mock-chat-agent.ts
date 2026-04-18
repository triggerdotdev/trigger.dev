import type { UIMessage, UIMessageChunk } from "ai";
import { resourceCatalog } from "@trigger.dev/core/v3";
import type { LocalsKey } from "@trigger.dev/core/v3";
import {
  runInMockTaskContext,
  type MockTaskContextOptions,
} from "@trigger.dev/core/v3/test";
import { CHAT_MESSAGES_STREAM_ID, CHAT_STOP_STREAM_ID } from "../chat-constants.js";

/** Pre-seed locals before the agent's `run()` starts. */
export type SetupLocals = (locals: {
  set<T>(key: LocalsKey<T>, value: T): void;
}) => void | Promise<void>;

// The wire payload shape used by chat.agent tasks. Kept loose here so we
// don't import from the backend-only ai.ts module.
type ChatWirePayload = {
  messages: UIMessage[];
  chatId: string;
  trigger: "submit-message" | "regenerate-message" | "preload" | "close" | "action";
  messageId?: string;
  metadata?: unknown;
  action?: unknown;
  continuation?: boolean;
  previousRunId?: string;
  idleTimeoutInSeconds?: number;
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
   */
  preload?: boolean;
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
   * Send a user message and wait for the next turn-complete. Returns the
   * chunks produced during this turn.
   */
  sendMessage(message: UIMessage | UIMessage[]): Promise<MockChatAgentTurn>;

  /** Send a regenerate signal with the messages and wait for the next turn-complete. */
  sendRegenerate(messages: UIMessage[]): Promise<MockChatAgentTurn>;

  /** Send a custom action and wait for the next turn-complete. */
  sendAction(action: unknown): Promise<MockChatAgentTurn>;

  /** Fire a stop signal. Does not wait for the turn — the task keeps running. */
  sendStop(message?: string): Promise<void>;

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
  const preload = options.preload ?? true;
  const clientData = options.clientData;

  const taskEntry = resourceCatalog.getTask(agent.id);
  if (!taskEntry) {
    throw new Error(
      `mockChatAgent: no task registered with id "${agent.id}". ` +
        `Import "@trigger.dev/sdk/ai/test" before your agent module so tasks register correctly.`
    );
  }

  const runFn = taskEntry.fns.run;

  // Buffers that survive across harness method calls
  const allRawChunks: unknown[] = [];
  const allChunks: UIMessageChunk[] = [];

  // Promise that resolves when the background task run() function returns.
  let taskFinished!: Promise<void>;
  // Drivers exposed by runInMockTaskContext — set inside the ctx callback
  let sendToInput!: (streamId: string, data: unknown) => Promise<void>;
  let closeInputStream: ((streamId: string) => void) | undefined;
  let outputChunksSince!: (previousLength: number) => unknown[];
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

  taskFinished = runInMockTaskContext(
    async (drivers) => {
      runSignal = new AbortController();

      // Override the ctx.run.id so it matches the harness. Note:
      // runInMockTaskContext already set a default — we just re-expose it.
      const initialPayload: ChatWirePayload = {
        messages: [],
        chatId,
        trigger: preload ? "preload" : "submit-message",
        metadata: clientData,
      };

      sendToInput = drivers.inputs.send;
      closeInputStream = drivers.inputs.close;

      // Subscribe to every chunk written to any realtime stream. We only
      // care about the "chat" stream (where chat.agent pipes its output),
      // but accepting all streams keeps the harness forward-compatible.
      const unsubscribe = drivers.outputs.onWrite((streamId, chunk) => {
        if (streamId !== "chat") return;
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
      });

      outputChunksSince = (previousLength) => allRawChunks.slice(previousLength);

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
  ).catch((err) => {
    // Propagate errors to pending turn waiters instead of dropping them
    const resolvers = turnCompleteResolvers;
    turnCompleteResolvers = [];
    for (const resolve of resolvers) resolve();
    throw err;
  });

  const sendPayloadAndWait = async (
    payload: ChatWirePayload
  ): Promise<MockChatAgentTurn> => {
    await harnessReady;
    const before = allRawChunks.length;
    const turnComplete = waitForTurnComplete();
    await sendToInput(CHAT_MESSAGES_STREAM_ID, payload);
    await turnComplete;
    const rawChunks = outputChunksSince(before);
    const chunks = rawChunks.filter(
      (c) => !isControlChunk(c)
    ) as UIMessageChunk[];
    return { chunks, rawChunks };
  };

  const harness: MockChatAgentHarness = {
    chatId,

    async sendMessage(message) {
      const messages = Array.isArray(message) ? message : [message];
      return sendPayloadAndWait({
        messages,
        chatId,
        trigger: "submit-message",
        metadata: clientData,
      });
    },

    async sendRegenerate(messages) {
      return sendPayloadAndWait({
        messages,
        chatId,
        trigger: "regenerate-message",
        metadata: clientData,
      });
    },

    async sendAction(action) {
      return sendPayloadAndWait({
        messages: [],
        chatId,
        trigger: "action",
        action,
        metadata: clientData,
      });
    },

    async sendStop(message) {
      await harnessReady;
      await sendToInput(CHAT_STOP_STREAM_ID, { stop: true, message });
    },

    async close() {
      await harnessReady;

      // Send a close trigger. The turn loop checks for this after a
      // successful turn and exits cleanly. On error-recovery paths the
      // loop just loops back with the close payload, so we also close
      // the input stream below to unblock any pending once() waiters.
      try {
        await sendToInput(CHAT_MESSAGES_STREAM_ID, {
          messages: [],
          chatId,
          trigger: "close",
        });
      } catch {
        // best-effort
      }
      // Resolve any pending once() waiters on the chat-messages stream
      // with a timeout error — that makes waitWithIdleTimeout return
      // `{ ok: false }` and the turn loop exits cleanly.
      closeInputStream?.(CHAT_MESSAGES_STREAM_ID);

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
