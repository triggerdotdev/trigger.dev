import { fromContext } from "./context.js";
import type { PhaseRecord, State } from "./state.js";

const MAX_ERROR_MSG_BYTES = 512;

/** Optional knobs for a phase record. */
export type PhaseOpt = {
  /** Attempt count for the phase (default 1). */
  attempts?: number;
  /** Sub-timings to fold into `phase.<name>.<key>`. */
  sub?: Record<string, number>;
};

/**
 * Appends a phase outcome to `state.phases`. Safe to call on success
 * (`err === undefined`) and error paths. `errorMsg` is truncated to 512 bytes
 * to keep the wide event compact. No-op if state is null.
 */
export function recordPhase(
  state: State | null,
  name: string,
  startMs: number,
  err: Error | undefined,
  opts: PhaseOpt = {}
): void {
  if (!state) return;
  const p: PhaseRecord = {
    name,
    durationMs: Math.round(performance.now() - startMs),
    ok: err === undefined,
    attempts: opts.attempts ?? 1,
  };
  if (err) {
    p.errorCode = err.name || "Error";
    const msg = err.message;
    p.errorMsg = msg.length > MAX_ERROR_MSG_BYTES ? msg.slice(0, MAX_ERROR_MSG_BYTES) : msg;
  }
  if (opts.sub) p.sub = opts.sub;
  state.phases.push(p);
}

/**
 * Runs `fn` and appends a phase outcome to the State attached to the current
 * async context. If no state is on context (test paths, background work),
 * `fn` runs unchanged. The phase is recorded on both success and error paths
 * so failed phases still appear in the wide event with duration_ms +
 * error_code.
 */
export async function timePhase<T>(
  name: string,
  fn: () => Promise<T> | T,
  opts: PhaseOpt = {}
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    recordPhase(fromContext(), name, start, undefined, opts);
    return result;
  } catch (err) {
    recordPhase(fromContext(), name, start, asError(err), opts);
    throw err;
  }
}

/**
 * Appends a phase outcome to the State attached to the current async context
 * using a `startMs` captured by the caller. Use when the phase boundary spans
 * multiple calls with intermediate error handling that can't fit inside a
 * single `timePhase` closure. Nil-state safe.
 */
export function recordPhaseSince(
  name: string,
  startMs: number,
  err: Error | undefined,
  opts: PhaseOpt = {}
): void {
  recordPhase(fromContext(), name, startMs, err, opts);
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
