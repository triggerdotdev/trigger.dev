/**
 * Wide-event observability surface for the supervisor. One flat-keyed JSON
 * line per natural unit of work (HTTP request, dequeue iteration, socket
 * lifecycle event). Events join across services via `trace_id` (parsed from
 * the inbound W3C `traceparent`) and `meta.run_id`.
 *
 * Off by default behind a kill switch - the dispatch hotpath runs at high
 * QPS, so logging pressure must be cleanly removable.
 */
export { fromContext } from "./context.js";
export { recordPhaseSince } from "./record.js";
export {
  emitOneShot,
  runWideEvent,
  setExtra,
  setMeta,
  type WideEventOptions,
} from "./middleware.js";
export type { ErrorInfo, PhaseRecord, State } from "./state.js";
export { encodeBaggage } from "./baggage.js";
