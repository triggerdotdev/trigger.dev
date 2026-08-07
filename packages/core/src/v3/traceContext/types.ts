import type { Context } from "@opentelemetry/api";

export interface TraceContextManager {
  getTraceContext(): Record<string, unknown>;
  /**
   * Increments every time the trace context is replaced, which on a worker that
   * reuses one process across runs is the run boundary. Long-lived consumers
   * compare it to tell "still the same run" from "a new run started".
   */
  getTraceContextEpoch(): number;
  extractContext(): Context;
  reset(): void;
  getExternalTraceContext():
    | {
        traceId: string;
        spanId: string;
        traceFlags: number;
        tracestate?: string;
      }
    | undefined;
  withExternalTrace<T>(fn: () => T): T;
}
