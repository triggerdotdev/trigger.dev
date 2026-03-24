import { randomBytes } from "crypto";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";

const logger = new SimpleStructuredLogger("otlp-trace");

export interface OtlpTraceOptions {
  traceId: string;
  parentSpanId?: string;
  spanName: string;
  startTimeMs: number;
  endTimeMs: number;
  resourceAttributes: Record<string, string | number | boolean>;
  spanAttributes: Record<string, string | number | boolean>;
}

/** Build an OTLP JSON ExportTraceServiceRequest payload */
export function buildOtlpTracePayload(opts: OtlpTraceOptions) {
  const spanId = randomBytes(8).toString("hex");

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "$trigger", value: { boolValue: true } },
            ...toOtlpAttributes(opts.resourceAttributes),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "supervisor.compute" },
            spans: [
              {
                traceId: opts.traceId,
                spanId,
                parentSpanId: opts.parentSpanId,
                name: opts.spanName,
                kind: 3, // SPAN_KIND_CLIENT
                startTimeUnixNano: String(opts.startTimeMs * 1_000_000),
                endTimeUnixNano: String(opts.endTimeMs * 1_000_000),
                attributes: toOtlpAttributes(opts.spanAttributes),
                status: { code: 1 }, // STATUS_CODE_OK
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Fire-and-forget: send an OTLP trace payload to the collector */
export function sendOtlpTrace(
  endpoint: string,
  payload: ReturnType<typeof buildOtlpTracePayload>
) {
  fetch(`${endpoint}/v1/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  }).catch((err) => {
    logger.warn("failed to send compute provision span", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
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
