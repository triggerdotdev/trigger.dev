/**
 * Per-event accumulator backing a single wide event. The supervisor emits one
 * flat-keyed JSON line per natural unit of work (dequeue iteration, HTTP
 * request, socket lifecycle event). Optional fields are omitted on emit so
 * events stay compact.
 */
export type State = {
  /**
   * Wall-clock time the event began, as an ISO-8601 string. Emitted as
   * `start_time` so log collection orders events by when work started rather
   * than by the collector's ingestion time.
   */
  startTime?: string;

  // Cross-stack correlation.
  requestId: string;
  traceId: string;
  /**
   * Raw inbound W3C `traceparent`, preserved verbatim so outbound calls can
   * propagate the same trace context without losing the parent span-id.
   * Empty when no inbound traceparent was set.
   */
  traceparent: string;

  // Service identity (set by `newState` from Env).
  service: string;
  version?: string;
  commitSha?: string;
  region?: string;
  nodeId?: string;

  /**
   * Operation discriminator. Dotted `noun.verb` (e.g. `instance.create`,
   * `snapshot.dispatch`). Low cardinality - bounded set per service, not
   * unbounded. Empty allowed during construction but expected to be set
   * before emit.
   */
  op: string;

  /**
   * Event shape. `inbound` for received requests, `outbound` for outgoing
   * calls, `event` for ambient occurrences with no meaningful duration,
   * `scheduled` for timer-driven work. Empty allowed; omitted from emit
   * when empty.
   */
  kind: string;

  // Caller-attached opaque metadata, flattened to `meta.<key>` on emit.
  meta: Record<string, string>;

  // Per-phase outcomes, in completion order.
  phases: PhaseRecord[];

  // Top-level outcome (set after the wrapped operation returns).
  ok: boolean;
  statusCode: number;
  durationMs: number;
  error?: ErrorInfo;

  // Free-form ad-hoc additions (route, method, did_warm_start, ...).
  extras: Record<string, unknown>;
};

/**
 * Single named phase outcome. Retries collapse into `attempts > 1` with the
 * last error reflected in errorCode/errorMsg.
 */
export type PhaseRecord = {
  name: string;
  durationMs: number;
  ok: boolean;
  attempts: number;
  errorCode?: string;
  errorMsg?: string;
  sub?: Record<string, number>;
};

/** Top-level error summary for a failed operation. */
export type ErrorInfo = {
  code: string;
  message: string;
  /** Coarse classification - "client" | "upstream" | "internal" | "timeout". */
  kind: string;
};
