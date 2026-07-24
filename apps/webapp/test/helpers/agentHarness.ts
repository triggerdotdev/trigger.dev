import { apiClientManager, resourceCatalog } from "@trigger.dev/core/v3";
import type { LocalsKey } from "@trigger.dev/core/v3";
import type { LanguageModel } from "ai";
import {
  installSessionWaitpointBackend,
  runInMockTaskContext,
  StandardSessionStreamManager,
} from "@trigger.dev/core/v3/test";

export type RunRealChatAgentOptions = {
  agentId: string;
  baseUrl: string;
  addressingKey: string;
  /**
   * The environment secret key. The agent writes `.out` and reads `.in` as the
   * backend (PRIVATE auth) — the `.out` channel rejects client session tokens.
   */
  secretKey: string;
  model: LanguageModel;
  modelLocal: LocalsKey<LanguageModel>;
  runId?: string;
  /**
   * Boot as a continuation of a previous run for the same session. Gates the
   * snapshot + `.out`/`.in` replay boot path, so the agent restores prior
   * history instead of treating the chat as brand new.
   */
  continuation?: boolean;
  previousRunId?: string;
  /**
   * Idle window (seconds) before the turn loop falls through from the SSE
   * once() to the suspending `session.in.wait()`. Set this low to force the
   * suspend/resume path in a test.
   */
  idleTimeoutInSeconds?: number;
};

export type RunningAgent = {
  done: Promise<void>;
  close: () => Promise<void>;
};

/**
 * Run the real `chat.agent` turn loop in-process, wired to a running webapp:
 * `apiClientManager` + a real `StandardSessionStreamManager` point the agent's
 * `.in`/`.out` at the webapp's Session streams (real S2 + SSE), the model is
 * injected via locals (so it survives without serialization), and turns are
 * driven by appending to `.in` over HTTP. Callers keep each message inside the
 * idle window and `close()` promptly so the run-engine suspend path is never
 * reached.
 */
export function runRealChatAgent(opts: RunRealChatAgentOptions): RunningAgent {
  apiClientManager.setGlobalAPIClientConfiguration({
    baseURL: opts.baseUrl,
    accessToken: opts.secretKey,
  });
  const apiClient = apiClientManager.clientOrThrow();
  const manager = new StandardSessionStreamManager(apiClient, opts.baseUrl);
  const { runtimeManager, restore } = installSessionWaitpointBackend(apiClient);

  const taskEntry = resourceCatalog.getTask(opts.agentId);
  if (!taskEntry) {
    restore();
    throw new Error(`runRealChatAgent: agent "${opts.agentId}" is not registered`);
  }
  const runFn = taskEntry.fns.run as (
    payload: unknown,
    params: { ctx: unknown; signal: AbortSignal }
  ) => Promise<unknown>;

  const runSignal = new AbortController();
  const runId = opts.runId ?? `run_${opts.addressingKey}`;

  const idle =
    opts.idleTimeoutInSeconds !== undefined
      ? { idleTimeoutInSeconds: opts.idleTimeoutInSeconds }
      : {};

  const done = (
    runInMockTaskContext(
      async (drivers) => {
        drivers.locals.set(opts.modelLocal, opts.model);
        const payload = opts.continuation
          ? {
              chatId: opts.addressingKey,
              continuation: true,
              metadata: {},
              ...idle,
              ...(opts.previousRunId ? { previousRunId: opts.previousRunId } : {}),
            }
          : { chatId: opts.addressingKey, trigger: "preload", metadata: {}, ...idle };
        await runFn(payload, { ctx: drivers.ctx, signal: runSignal.signal });
      },
      { ctx: { run: { id: runId } }, sessionStreamManager: manager, runtimeManager }
    ) as Promise<void>
  ).finally(restore);

  return {
    done,
    close: async () => {
      try {
        await fetch(
          `${opts.baseUrl}/realtime/v1/sessions/${encodeURIComponent(opts.addressingKey)}/in/append`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${opts.secretKey}`,
              "Content-Type": "application/json",
              "X-Part-Id": "close",
            },
            body: JSON.stringify({
              kind: "message",
              payload: { chatId: opts.addressingKey, trigger: "close" },
            }),
          }
        );
      } catch {}
      runSignal.abort();
      await Promise.race([
        done.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    },
  };
}

export type ChatAgentSessionOptions = Omit<
  RunRealChatAgentOptions,
  "runId" | "continuation" | "previousRunId"
>;

export type ChatAgentSession = {
  /** How many runs the session has spawned so far (1 fresh + N continuations). */
  runCount: () => number;
  /** Close the currently-active run and stop spawning continuations. */
  close: () => Promise<void>;
};

/**
 * A session-scoped orchestrator that stands in for the run-engine's run
 * lifecycle: it starts a run, and whenever that run exits on its own
 * (`chat.endRun()` / `chat.requestUpgrade()`), spawns the next run as a
 * continuation (new run id, `continuation: true`, `previousRunId` threaded)
 * for the same session. That mirrors the server triggering a fresh run on the
 * next append after the previous run went terminal, and lets each continuation
 * restore prior history from the persisted snapshot. Runs never overlap: the
 * next spawn is chained on the previous run's `done` (after its manager
 * teardown), so the process-global managers are never installed twice at once.
 */
export function runChatAgentSession(opts: ChatAgentSessionOptions): ChatAgentSession {
  let closed = false;
  let index = 0;
  let current: RunningAgent | undefined;
  let previousRunId: string | undefined;

  const spawn = () => {
    index += 1;
    const runId = `run_${opts.addressingKey}_${index}`;
    current = runRealChatAgent({
      ...opts,
      runId,
      continuation: index > 1,
      previousRunId,
    });
    previousRunId = runId;
    const settle = () => {
      if (!closed) {
        spawn();
      }
    };
    current.done.then(settle, settle);
  };

  spawn();

  return {
    runCount: () => index,
    close: async () => {
      closed = true;
      await current?.close();
    },
  };
}
