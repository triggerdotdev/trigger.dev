import { metrics } from "@opentelemetry/api";
import { traceContext } from "@trigger.dev/core/v3";

export const otel = {
  withExternalTrace: <T>(fn: () => T): T => {
    return traceContext.withExternalTrace(fn);
  },
  metrics,
};
