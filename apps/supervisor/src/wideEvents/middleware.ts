import { emit } from "./emit.js";
import { newState, type Env } from "./new.js";
import { wideEventStorage } from "./context.js";
import type { State } from "./state.js";

/** Options common to every wide-event lifecycle. */
export type WideEventOptions = {
  service: string;
  env: Env;
  /**
   * Kill switch. When false, lifecycles degenerate into transparent
   * pass-through - no State allocation, no AsyncLocalStorage run, no emit.
   * Important for the dispatch hotpath where logging pressure must be
   * cleanly removable.
   */
  enabled: boolean;
};

/** Per-invocation options layered on top of `WideEventOptions`. */
export type WideEventLifecycleOptions = WideEventOptions & {
  /** Route template (HTTP only) captured into `extras.route`. */
  route?: string;
  /** HTTP method captured into `extras.method`. */
  method?: string;
  /** Inbound W3C traceparent (HTTP header, queue message field). */
  traceparent?: string;
  /** Inbound request id (e.g. `x-request-id` header). */
  inboundRequestId?: string;
  /** Runs after the state is built, before the wrapped fn. Use to attach meta. */
  setup?: (state: State) => void;
};

/**
 * Runs `fn` inside an AsyncLocalStorage state and emits one wide event on
 * completion or error. `finalize` runs after `fn` returns but before emit -
 * use it to read out-of-band outcome info (e.g. `res.statusCode` for an HTTP
 * route) and assign to `state.statusCode`. The wrapper computes `ok` from
 * `statusCode` if it's set; otherwise it defaults to true on success.
 *
 * Returns the original `fn` result. When `enabled=false`, `fn` runs unchanged
 * with no event emitted.
 */
export async function runWideEvent<T>(
  opts: WideEventLifecycleOptions,
  fn: () => Promise<T> | T,
  finalize?: (state: State) => void
): Promise<T> {
  if (!opts.enabled) {
    return fn();
  }

  const state = newState({
    service: opts.service,
    env: opts.env,
    inboundRequestId: opts.inboundRequestId,
    traceparent: opts.traceparent,
  });
  if (opts.route) state.extras.route = opts.route;
  if (opts.method) state.extras.method = opts.method;
  if (opts.setup) opts.setup(state);

  const start = performance.now();
  try {
    const result = await wideEventStorage.run(state, () => Promise.resolve(fn()));
    state.durationMs = Math.round(performance.now() - start);
    if (finalize) finalize(state);
    if (state.statusCode !== 0) {
      state.ok = state.statusCode >= 200 && state.statusCode < 300;
    } else {
      state.ok = true;
    }
    emit(state);
    return result;
  } catch (err) {
    state.durationMs = Math.round(performance.now() - start);
    const e = err instanceof Error ? err : new Error(String(err));
    if (state.statusCode === 0) state.statusCode = 500;
    state.ok = false;
    state.error = {
      code: e.name || "Error",
      message: e.message,
      kind: "internal",
    };
    emit(state);
    throw err;
  }
}

/**
 * One-shot wide event with no wrapped operation. Use for socket lifecycle
 * events (`run:start`, `run:stop`) where there is no surrounding async unit
 * of work to time. `populate` runs synchronously to attach meta/extras
 * before emit.
 */
export function emitOneShot(
  opts: WideEventOptions & {
    traceparent?: string;
    populate?: (state: State) => void;
  }
): void {
  if (!opts.enabled) return;
  const state = newState({
    service: opts.service,
    env: opts.env,
    traceparent: opts.traceparent,
  });
  if (opts.populate) opts.populate(state);
  state.ok = true;
  emit(state);
}

/** Convenience accessor for in-handler meta mutation. */
export function setMeta(state: State | null, key: string, value: string): void {
  if (!state) return;
  state.meta[key] = value;
}

/** Convenience for free-form fields (did_warm_start, dispatch.result, ...). */
export function setExtra(state: State | null, key: string, value: unknown): void {
  if (!state) return;
  state.extras[key] = value;
}
