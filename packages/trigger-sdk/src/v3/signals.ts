import {
  apiClientManager,
  signalNameError,
  signalPayloadError,
  signals as coreSignals,
  taskContext,
  type Signal,
  type SignalHandler,
} from "@trigger.dev/core/v3";

export type { Signal } from "@trigger.dev/core/v3";

/**
 * Signals: a small message sent to an environment, received by every executing run in it that
 * listens for the signal's name.
 *
 * Unstable: names and behavior may change before this is released.
 */
export const unstable_signals = {
  /**
   * Listen for a signal while this run executes. The latest signal of that name sent before the
   * call (if any) is delivered first, then each new one as it is sent. When both the signal sent to
   * every run and the one sent to this run's task exist, both are delivered, older first. A run that is waiting
   * (suspended) receives nothing while it waits; when it resumes it gets the latest of each name.
   *
   * @returns A function that stops listening.
   */
  on<TPayload = unknown>(name: string, handler: (signal: Signal<TPayload>) => void): () => void {
    throwIf(signalNameError(name, { allowReserved: true }));
    return coreSignals.on(name, handler as SignalHandler);
  },

  /**
   * The latest signal of `name`, read once without listening: use it to check the current state
   * before starting work. Inside a run, it is the newer of the signal sent to every run and the one
   * sent to this run's task: the last of what `on(name)` delivers when it starts. Outside a run (or with
   * `task`), the one sent with exactly that `task`, or to every run when `task` is absent.
   *
   * @returns `undefined` when none has been sent, or it was cleared.
   */
  async latest<TPayload = unknown>(
    name: string,
    options?: { task?: string }
  ): Promise<Signal<TPayload> | undefined> {
    throwIf(signalNameError(name, { allowReserved: true }));
    const runTask = options?.task === undefined ? taskContext.ctx?.task.id : undefined;
    const { signal } = await apiClientManager.clientOrThrow().getLatestSignal({
      name,
      task: options?.task ?? runTask,
      includeUntasked: runTask !== undefined,
    });
    if (!signal) return undefined;
    return {
      name: signal.name,
      payload: signal.payload as TPayload,
      ...(signal.task !== undefined ? { task: signal.task } : {}),
      sentAt: new Date(signal.sentAt),
      seq: signal.seq,
    };
  },

  /**
   * Send a signal to every executing run in this environment that listens for `name`, or with
   * `task` only to that task's runs. Needs the secret key (from a task, the run's own credentials).
   * Not a queue: there is no acknowledgement and no per-run delivery record.
   */
  async send(
    name: string,
    payload?: unknown,
    options?: { task?: string }
  ): Promise<{ seq: number }> {
    throwIf(signalNameError(name) ?? signalPayloadError(payload));
    return apiClientManager
      .clientOrThrow()
      .sendSignal({ name, payload: payload ?? null, task: options?.task });
  },

  /**
   * Forget the latest signal of `name` (sent with `task`, if given): runs that start listening
   * afterwards don't receive it, and the name stops counting towards the environment's limit of
   * 32 names. Runs already listening aren't told; send a value that means "off" for that.
   *
   * @returns `cleared: false` when there was nothing to clear.
   */
  async clear(name: string, options?: { task?: string }): Promise<{ cleared: boolean }> {
    throwIf(signalNameError(name));
    const { cleared } = await apiClientManager
      .clientOrThrow()
      .clearSignal({ name, task: options?.task });
    return { cleared };
  },
};

function throwIf(error: string | undefined): void {
  if (error) throw new Error(error);
}
