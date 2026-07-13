/**
 * Wide-event observability surface for the supervisor. One flat-keyed JSON
 * line per natural unit of work (HTTP request, dequeue iteration, socket
 * lifecycle event). Events join across services via `trace_id` (parsed from
 * the inbound W3C `traceparent`) and `meta.run_id`.
 *
 * Off by default behind a kill switch - the dispatch hotpath runs at high
 * QPS, so logging pressure must be cleanly removable.
 */
export { type Env, isValidRequestId, newState, type NewStateOptions } from "./new.js";
export { emit, EmitMessage } from "./emit.js";
export { parseTraceId } from "./traceparent.js";
export { fromContext, wideEventStorage } from "./context.js";
export { type PhaseOpt, recordPhase, recordPhaseSince, timePhase } from "./record.js";
export {
  emitOneShot,
  runWideEvent,
  setExtra,
  setMeta,
  type WideEventLifecycleOptions,
  type WideEventOptions,
} from "./middleware.js";
export type { ErrorInfo, PhaseRecord, State } from "./state.js";
export { encodeBaggage } from "./baggage.js";
