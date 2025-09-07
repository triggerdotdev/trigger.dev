import { Context } from "@opentelemetry/api";

export interface TraceContextManager {
  getTraceContext(): Record<string, unknown>;
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
