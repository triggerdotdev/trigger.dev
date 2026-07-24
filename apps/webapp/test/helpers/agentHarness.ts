import { apiClientManager, resourceCatalog } from "@trigger.dev/core/v3";
import type { LocalsKey } from "@trigger.dev/core/v3";
import type { LanguageModel } from "ai";
import { runInMockTaskContext, StandardSessionStreamManager } from "@trigger.dev/core/v3/test";

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

  const taskEntry = resourceCatalog.getTask(opts.agentId);
  if (!taskEntry) {
    throw new Error(`runRealChatAgent: agent "${opts.agentId}" is not registered`);
  }
  const runFn = taskEntry.fns.run as (
    payload: unknown,
    params: { ctx: unknown; signal: AbortSignal }
  ) => Promise<unknown>;

  const runSignal = new AbortController();
  const runId = opts.runId ?? `run_${opts.addressingKey}`;

  const done = runInMockTaskContext(
    async (drivers) => {
      drivers.locals.set(opts.modelLocal, opts.model);
      const payload = opts.continuation
        ? {
            chatId: opts.addressingKey,
            continuation: true,
            metadata: {},
            ...(opts.previousRunId ? { previousRunId: opts.previousRunId } : {}),
          }
        : { chatId: opts.addressingKey, trigger: "preload", metadata: {} };
      await runFn(payload, { ctx: drivers.ctx, signal: runSignal.signal });
    },
    { ctx: { run: { id: runId } }, sessionStreamManager: manager }
  ) as Promise<void>;

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
