import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { env } from "./env.js";
import type { buildOtlpTracePayload } from "./otlpPayload.js";

const logger = new SimpleStructuredLogger("otlp-trace");

/** Fire-and-forget: send an OTLP trace payload to the configured endpoint */
export function sendOtlpTrace(payload: ReturnType<typeof buildOtlpTracePayload>) {
  fetch(`${env.COMPUTE_TRACE_OTLP_ENDPOINT}/v1/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  }).catch((err) => {
    logger.warn("failed to send compute trace span", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
