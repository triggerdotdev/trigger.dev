import { randomBytes } from "crypto";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";

export type OtlpTraceServiceOptions = {
  endpointUrl: string;
  timeoutMs?: number;
};

export type OtlpTraceSpan = {
  traceId: string;
  parentSpanId?: string;
  spanName: string;
  startTimeMs: number;
  endTimeMs: number;
  resourceAttributes: Record<string, string | number | boolean>;
  spanAttributes: Record<string, string | number | boolean>;
};

export class OtlpTraceService {
  private readonly logger = new SimpleStructuredLogger("otlp-trace");

  constructor(private opts: OtlpTraceServiceOptions) {}

  /** Fire-and-forget: build payload and send to the configured OTLP endpoint */
  emit(span: OtlpTraceSpan): void {
    const payload = buildPayload(span);

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

// ── Payload builder (internal) ───────────────────────────────────────────────

/** @internal Exported for tests only */
export function buildPayload(span: OtlpTraceSpan) {
  const spanId = randomBytes(8).toString("hex");

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "$trigger", value: { boolValue: true } },
            ...toOtlpAttributes(span.resourceAttributes),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "supervisor.compute" },
            spans: [
              {
                traceId: span.traceId,
                spanId,
                parentSpanId: span.parentSpanId,
                name: span.spanName,
                kind: 3, // SPAN_KIND_CLIENT
                startTimeUnixNano: msToNano(span.startTimeMs),
                endTimeUnixNano: msToNano(span.endTimeMs),
                attributes: toOtlpAttributes(span.spanAttributes),
                status: { code: 1 }, // STATUS_CODE_OK
              },
            ],
          },
        ],
      },
    ],
  };
}

function toOtlpAttributes(
  attrs: Record<string, string | number | boolean>
): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: toOtlpValue(value),
  }));
}

function toOtlpValue(value: string | number | boolean): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: value };
  return { doubleValue: value };
}

/**
 * Convert epoch milliseconds to nanosecond string, preserving sub-ms precision.
 * Fractional ms from performance.now() arithmetic carry meaningful microsecond
 * data that affects span sort ordering when events happen within the same ms.
 */
function msToNano(ms: number): string {
  const wholeMs = Math.trunc(ms);
  const fracNs = Math.round((ms - wholeMs) * 1_000_000);
  return String(BigInt(wholeMs) * 1_000_000n + BigInt(fracNs));
}
