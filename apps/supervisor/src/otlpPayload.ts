import { randomBytes } from "crypto";

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
