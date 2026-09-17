import {
  LogRecord,
  ResourceLogs,
  ResourceSpans,
  SeverityNumber,
  Span,
} from "@trigger.dev/otlp-importer";
import { describe, expect, it } from "vitest";
import {
  convertLogsToCreateableEvents,
  convertSpansToCreateableEvents,
} from "../app/v3/otlpTransform.server";

const traceId = Buffer.alloc(16, 1);
const spanId = Buffer.alloc(8, 1);

function resourceLogs(ids: { traceId: Buffer; spanId: Buffer }): ResourceLogs {
  return ResourceLogs.fromPartial({
    scopeLogs: [
      {
        logRecords: [
          LogRecord.fromPartial({
            ...ids,
            severityNumber: SeverityNumber.INFO,
            severityText: "INFO",
            timeUnixNano: 1n,
          }),
        ],
      },
    ],
  });
}

function resourceSpans(ids: { traceId: Buffer; spanId: Buffer }): ResourceSpans {
  return ResourceSpans.fromPartial({
    scopeSpans: [
      {
        spans: [
          Span.fromPartial({
            ...ids,
            name: "test span",
            startTimeUnixNano: 1n,
            endTimeUnixNano: 2n,
          }),
        ],
      },
    ],
  });
}

describe("OTLP event identifier validation", () => {
  it("drops logs with an empty trace ID", () => {
    const result = convertLogsToCreateableEvents(
      resourceLogs({ traceId: Buffer.alloc(0), spanId }),
      128,
      "v2"
    );

    expect(result.events).toEqual([]);
  });

  it("drops spans with an empty span ID", () => {
    const result = convertSpansToCreateableEvents(
      resourceSpans({ traceId, spanId: Buffer.alloc(0) }),
      128,
      "v2"
    );

    expect(result.events).toEqual([]);
  });
});
