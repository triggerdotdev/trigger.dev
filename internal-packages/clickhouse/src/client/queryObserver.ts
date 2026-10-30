import type { Attributes } from "@internal/tracing";

export type QueryObservation = {
  client: string;
  operation: string;
  readRows?: number;
  serverDurationMs?: number;
  errorType?: string;
};

/** Process-wide hooks into every client's query metrics, so callers can label and total them. */
export type QueryObserver = {
  /** Extra labels for the `clickhouse.query.*` metrics of the current query. */
  metricAttributes?: () => Attributes | undefined;
  onQuery?: (observation: QueryObservation) => void;
};

let observer: QueryObserver | undefined;

export function setQueryObserver(next: QueryObserver | undefined) {
  observer = next;
}

export function getQueryObserver(): QueryObserver | undefined {
  return observer;
}
