import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { buildOtlpTracePayload, type OtlpTraceOptions } from "../otlpPayload.js";

export type OtlpTraceServiceOptions = {
  endpointUrl: string;
  timeoutMs?: number;
};

export class OtlpTraceService {
  private readonly logger = new SimpleStructuredLogger("otlp-trace");

  constructor(private opts: OtlpTraceServiceOptions) {}

  /** Fire-and-forget: build payload and send to the configured OTLP endpoint */
  emit(opts: OtlpTraceOptions): void {
    const payload = buildOtlpTracePayload(opts);

    fetch(`${this.opts.endpointUrl}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
    }).catch((err) => {
      this.logger.warn("failed to send compute trace span", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
