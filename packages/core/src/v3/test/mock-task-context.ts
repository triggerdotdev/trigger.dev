import { inputStreams } from "../input-streams-api.js";
import { realtimeStreams } from "../realtime-streams-api.js";
import { sessionStreams } from "../session-streams-api.js";
import { localsAPI } from "../locals-api.js";
import { runMetadata } from "../run-metadata-api.js";
import { taskContext } from "../task-context-api.js";
import { lifecycleHooks } from "../lifecycle-hooks-api.js";
import { runtime } from "../runtime-api.js";
import { StandardLocalsManager } from "../locals/manager.js";
import { StandardLifecycleHooksManager } from "../lifecycleHooks/manager.js";
import { NoopRuntimeManager } from "../runtime/noopRuntimeManager.js";
import { unregisterGlobal } from "../utils/globals.js";
import type { ServerBackgroundWorker, TaskRunContext } from "../schemas/index.js";
import type { LocalsKey } from "../locals/types.js";
import type { SessionChannelIO } from "../sessionStreams/types.js";
import { TestInputStreamManager } from "./test-input-stream-manager.js";
import { TestRealtimeStreamsManager } from "./test-realtime-streams-manager.js";
import { TestRunMetadataManager } from "./test-run-metadata-manager.js";
import { TestSessionStreamManager } from "./test-session-stream-manager.js";

/**
 * Shallow-partial overrides applied on top of the default mock
 * `TaskRunContext`. Each sub-object is a partial of its real shape —
 * unset fields get sensible defaults.
 */
export type MockTaskRunContextOverrides = {
  task?: Partial<TaskRunContext["task"]>;
  attempt?: Partial<TaskRunContext["attempt"]>;
  run?: Partial<TaskRunContext["run"]>;
  machine?: Partial<TaskRunContext["machine"]>;
  queue?: Partial<TaskRunContext["queue"]>;
  environment?: Partial<TaskRunContext["environment"]>;
  organization?: Partial<TaskRunContext["organization"]>;
  project?: Partial<TaskRunContext["project"]>;
  batch?: TaskRunContext["batch"];
};

/**
 * Options for overriding parts of the mock task context.
 */
export type MockTaskContextOptions = {
  /** Overrides applied on top of the default mock `TaskRunContext`. */
  ctx?: MockTaskRunContextOverrides;
  /** Overrides applied on top of the default `ServerBackgroundWorker`. */
  worker?: Partial<ServerBackgroundWorker>;
  /** Whether this is a warm start. */
  isWarmStart?: boolean;
};

/**
 * Drivers passed to the function running inside `runInMockTaskContext`.
 */
export type MockTaskContextDrivers = {
  /** Push data into input streams — simulates realtime input from outside the task. */
  inputs: {
    /**
     * Send `data` to the named input stream. Resolves when all `.on()`
     * handlers have run.
     */
    send(streamId: string, data: unknown): Promise<void>;
    /** Resolve any pending `.once()` waiters with a timeout error. */
    close(streamId: string): void;
  };
  /** Inspect chunks written to output (realtime) streams. */
  outputs: {
    /** All chunks for a given stream, in the order they were written. */
    chunks<T = unknown>(streamId: string): T[];
    /** All chunks across every stream, keyed by stream id. */
    all(): Record<string, unknown[]>;
    /** Clear chunks for one stream, or all streams if no id is provided. */
    clear(streamId?: string): void;
    /**
     * Register a listener fired for every chunk written to any stream.
     * Returns an unsubscribe function.
     */
    onWrite(listener: (streamId: string, chunk: unknown) => void): () => void;
  };
  /** Read or seed locals for the run. */
  locals: {
    /** Read a local set by either the task or `set()` below. */
    get<T>(key: LocalsKey<T>): T | undefined;
    /**
     * Pre-seed a local before the task runs. Use this for dependency
     * injection — e.g. supply a test database client that the agent's
     * hooks read via `locals.get()` instead of constructing the prod one.
     */
    set<T>(key: LocalsKey<T>, value: T): void;
  };
  /**
   * Session-scoped channel drivers. The `.in` side is backed by a
   * {@link TestSessionStreamManager} installed as the `sessionStreams`
   * global — so the task's `session.in.on/once/peek/waitWithIdleTimeout`
   * calls receive records sent through this driver.
   */
  sessions: {
    in: {
      /**
       * Send a record onto `session.in` for the given session. Resolves
       * pending `once()` waiters and fires all `on()` handlers.
       */
      send(sessionId: string, data: unknown, io?: SessionChannelIO): Promise<void>;
      /** Close pending `once()` waiters with a timeout error. */
      close(sessionId: string, io?: SessionChannelIO): void;
    };
  };
  /** The mock `TaskRunContext` assembled from defaults + user overrides. */
  ctx: TaskRunContext;
};

function defaultTaskRunContext(overrides?: MockTaskRunContextOverrides): TaskRunContext {
  return {
    task: {
      id: "test-task",
      filePath: "test-task.ts",
      ...overrides?.task,
    },
    attempt: {
      number: 1,
      startedAt: new Date(),
      ...overrides?.attempt,
    },
    run: {
      id: "run_test",
      tags: [],
      isTest: false,
      createdAt: new Date(),
      startedAt: new Date(),
      ...overrides?.run,
    },
    machine: {
      name: "micro",
      cpu: 1,
      memory: 0.5,
      centsPerMs: 0,
      ...overrides?.machine,
    },
    queue: {
      name: "test-queue",
      id: "test-queue-id",
      ...overrides?.queue,
    },
    environment: {
      id: "test-env-id",
      slug: "test-env",
      type: "DEVELOPMENT",
      ...overrides?.environment,
    },
    organization: {
      id: "test-org-id",
      slug: "test-org",
      name: "Test Org",
      ...overrides?.organization,
    },
    project: {
      id: "test-project-id",
      ref: "test-project-ref",
      slug: "test-project",
      name: "Test Project",
      ...overrides?.project,
    },
    batch: overrides?.batch,
  };
}

function defaultWorker(overrides?: Partial<ServerBackgroundWorker>): ServerBackgroundWorker {
  return {
    id: "test-worker-id",
    version: "test-version",
    contentHash: "test-content-hash",
    engine: "V2",
    ...overrides,
  };
}

/**
 * Run a function inside a fully mocked task runtime context.
 *
 * Installs in-memory test managers for `locals`, `inputStreams`,
 * `realtimeStreams`, `lifecycleHooks`, and `runtime`, sets a mock
 * `TaskContext`, and tears everything down when the function returns.
 *
 * Inside the function, any code that reads from `locals`, `inputStreams`,
 * `realtimeStreams`, or `taskContext.ctx` will see the mock context —
 * so you can directly invoke the internal `run` function of any task
 * (including `chat.agent`) without hitting the Trigger.dev runtime.
 *
 * @example
 * ```ts
 * import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
 *
 * await runInMockTaskContext(
 *   async ({ inputs, outputs, ctx }) => {
 *     // Fire an input stream from the "outside"
 *     setTimeout(() => {
 *       inputs.send("chat-messages", { messages: [], chatId: "c1" });
 *     }, 0);
 *
 *     // Run task code that reads from inputStreams.once(...)
 *     await myTask.fns.run(payload, { ctx, signal: new AbortController().signal });
 *
 *     // Inspect chunks written to the output stream
 *     expect(outputs.chunks("chat")).toContainEqual({ type: "text-delta", delta: "hi" });
 *   },
 *   { ctx: { run: { id: "run_abc" } } }
 * );
 * ```
 */
export async function runInMockTaskContext<T>(
  fn: (drivers: MockTaskContextDrivers) => T | Promise<T>,
  options?: MockTaskContextOptions
): Promise<T> {
  const ctx = defaultTaskRunContext(options?.ctx);
  const worker = defaultWorker(options?.worker);

  const localsManager = new StandardLocalsManager();
  const lifecycleManager = new StandardLifecycleHooksManager();
  const runtimeManager = new NoopRuntimeManager();
  const metadataManager = new TestRunMetadataManager();
  const inputManager = new TestInputStreamManager();
  const outputManager = new TestRealtimeStreamsManager();
  const sessionStreamManager = new TestSessionStreamManager();

  // Unregister any previously-installed managers so `setGlobal*` wins —
  // `registerGlobal` returns false silently if an entry already exists.
  unregisterGlobal("locals");
  unregisterGlobal("lifecycle-hooks");
  unregisterGlobal("runtime");
  unregisterGlobal("run-metadata");
  unregisterGlobal("input-streams");
  unregisterGlobal("realtime-streams");
  unregisterGlobal("session-streams");
  unregisterGlobal("task-context");

  localsAPI.setGlobalLocalsManager(localsManager);
  lifecycleHooks.setGlobalLifecycleHooksManager(lifecycleManager);
  runtime.setGlobalRuntimeManager(runtimeManager);
  runMetadata.setGlobalManager(metadataManager);
  inputStreams.setGlobalManager(inputManager);
  realtimeStreams.setGlobalManager(outputManager);
  sessionStreams.setGlobalManager(sessionStreamManager);
  taskContext.setGlobalTaskContext({
    ctx,
    worker,
    isWarmStart: options?.isWarmStart ?? false,
  });

  const drivers: MockTaskContextDrivers = {
    inputs: {
      send: (streamId, data) => inputManager.__sendFromTest(streamId, data),
      close: (streamId) => inputManager.__closeFromTest(streamId),
    },
    outputs: {
      chunks: (streamId) => outputManager.__chunksFromTest(streamId),
      all: () => outputManager.__allChunksFromTest(),
      clear: (streamId) => outputManager.__clearFromTest(streamId),
      onWrite: (listener) => outputManager.onWrite(listener),
    },
    locals: {
      get: <TValue>(key: LocalsKey<TValue>) => localsManager.getLocal(key),
      set: <TValue>(key: LocalsKey<TValue>, value: TValue) =>
        localsManager.setLocal(key, value),
    },
    sessions: {
      in: {
        send: (sessionId, data, io = "in") =>
          sessionStreamManager.__sendFromTest(sessionId, io, data),
        close: (sessionId, io = "in") =>
          sessionStreamManager.__closeFromTest(sessionId, io),
      },
    },
    ctx,
  };

  try {
    return await fn(drivers);
  } finally {
    localsAPI.disable();
    lifecycleHooks.disable();
    runtime.disable();
    // taskContext.disable() only sets a flag — unregister the global so
    // `taskContext.ctx` returns undefined after the harness returns.
    unregisterGlobal("task-context");
    unregisterGlobal("input-streams");
    unregisterGlobal("realtime-streams");
    unregisterGlobal("session-streams");
    unregisterGlobal("run-metadata");
    localsManager.reset();
    inputManager.reset();
    outputManager.reset();
    sessionStreamManager.reset();
    metadataManager.reset();
  }
}
