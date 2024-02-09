import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3";
import {
  AnyValue,
  ExportLogsServiceRequest,
  ExportLogsServiceResponse,
  ExportTraceServiceRequest,
  ExportTraceServiceResponse,
  KeyValue,
  ResourceLogs,
  ResourceSpans,
  SeverityNumber,
  Span,
  Span_Event,
  Span_Link,
  Span_SpanKind,
  Status_StatusCode,
} from "@trigger.dev/otlp-importer";
import {
  CreatableEventKind,
  CreatableEventStatus,
  EventRepository,
  eventRepository,
  type CreatableEvent,
  CreatableEventEnvironmentType,
} from "./eventRepository.server";

export type OTLPExporterConfig = {
  batchSize: number;
  batchInterval: number;
};

class OTLPExporter {
  constructor(private readonly _eventRepository: EventRepository) {}

  async exportTraces(request: ExportTraceServiceRequest): Promise<ExportTraceServiceResponse> {
    const events = this.#filterResourceSpans(request.resourceSpans).flatMap((resourceSpan) => {
      return convertSpansToCreateableEvents(resourceSpan);
    });

    this._eventRepository.insertMany(events);

    return ExportTraceServiceResponse.create();
  }

  async exportLogs(request: ExportLogsServiceRequest): Promise<ExportLogsServiceResponse> {
    const events = this.#filterResourceLogs(request.resourceLogs).flatMap((resourceLog) => {
      return convertLogsToCreateableEvents(resourceLog);
    });

    this._eventRepository.insertMany(events);

    return ExportLogsServiceResponse.create();
  }

  #filterResourceSpans(
    resourceSpans: ExportTraceServiceRequest["resourceSpans"]
  ): ExportTraceServiceRequest["resourceSpans"] {
    return resourceSpans.filter((resourceSpan) => {
      const triggerAttribute = resourceSpan.resource?.attributes.find(
        (attribute) => attribute.key === SemanticInternalAttributes.TRIGGER
      );

      return isBoolValue(triggerAttribute?.value) ? triggerAttribute.value.value.boolValue : false;
    });
  }

  #filterResourceLogs(
    resourceLogs: ExportLogsServiceRequest["resourceLogs"]
  ): ExportLogsServiceRequest["resourceLogs"] {
    return resourceLogs.filter((resourceLog) => {
      const attribute = resourceLog.resource?.attributes.find(
        (attribute) => attribute.key === SemanticInternalAttributes.TRIGGER
      );

      return isBoolValue(attribute?.value) ? attribute.value.value.boolValue : false;
    });
  }
}

function convertLogsToCreateableEvents(resourceLog: ResourceLogs): Array<CreatableEvent> {
  const resourceAttributes = resourceLog.resource?.attributes ?? [];

  const resourceProperties = extractResourceProperties(resourceAttributes);

  return resourceLog.scopeLogs.flatMap((scopeLog) => {
    return scopeLog.logRecords.map((log) => {
      return {
        traceId: binaryToHex(log.traceId),
        spanId: eventRepository.generateSpanId(),
        parentId: binaryToHex(log.spanId),
        message: isStringValue(log.body) ? log.body.value.stringValue : `${log.severityText} log`,
        isPartial: false,
        kind: "INTERNAL",
        level: logLevelToEventLevel(log.severityNumber),
        status: logLevelToEventStatus(log.severityNumber),
        startTime: convertUnixNanoToDate(log.timeUnixNano),
        properties: {
          ...convertKeyValueItemsToMap(log.attributes ?? [], [
            SemanticInternalAttributes.SPAN_ID,
            SemanticInternalAttributes.SPAN_PARTIAL,
          ]),
          ...convertKeyValueItemsToMap(
            resourceAttributes,
            [SemanticInternalAttributes.TRIGGER],
            SemanticInternalAttributes.METADATA
          ),
        },
        style: convertKeyValueItemsToMap(
          pickAttributes(log.attributes ?? [], SemanticInternalAttributes.STYLE),
          []
        ),
        output: convertKeyValueItemsToMap(
          pickAttributes(log.attributes ?? [], SemanticInternalAttributes.OUTPUT),
          []
        ),
        ...resourceProperties,
      };
    });
  });
}

function convertSpansToCreateableEvents(resourceSpan: ResourceSpans): Array<CreatableEvent> {
  const resourceAttributes = resourceSpan.resource?.attributes ?? [];

  const resourceProperties = extractResourceProperties(resourceAttributes);

  return resourceSpan.scopeSpans.flatMap((scopeSpan) => {
    return scopeSpan.spans.map((span) => {
      const isPartial = isPartialSpan(span);

      return {
        traceId: binaryToHex(span.traceId),
        spanId: isPartial
          ? extractStringAttribute(
              span?.attributes ?? [],
              SemanticInternalAttributes.SPAN_ID,
              binaryToHex(span.spanId)
            )
          : binaryToHex(span.spanId),
        parentId: binaryToHex(span.parentSpanId),
        message: span.name,
        isPartial,
        kind: spanKindToEventKind(span.kind),
        level: "TRACE",
        status: spanStatusToEventStatus(span.status),
        startTime: convertUnixNanoToDate(span.startTimeUnixNano),
        links: spanLinksToEventLinks(span.links ?? []),
        events: spanEventsToEventEvents(span.events ?? []),
        duration: span.endTimeUnixNano - span.startTimeUnixNano,
        properties: {
          ...convertKeyValueItemsToMap(span.attributes ?? [], [
            SemanticInternalAttributes.SPAN_ID,
            SemanticInternalAttributes.SPAN_PARTIAL,
          ]),
          ...convertKeyValueItemsToMap(
            resourceAttributes,
            [SemanticInternalAttributes.TRIGGER],
            SemanticInternalAttributes.METADATA
          ),
        },
        style: convertKeyValueItemsToMap(
          pickAttributes(span.attributes ?? [], SemanticInternalAttributes.STYLE),
          []
        ),
        output: convertKeyValueItemsToMap(
          pickAttributes(span.attributes ?? [], SemanticInternalAttributes.OUTPUT),
          []
        ),
        ...resourceProperties,
      };
    });
  });
}

function extractResourceProperties(attributes: KeyValue[]) {
  return {
    metadata: convertKeyValueItemsToMap(attributes, [SemanticInternalAttributes.TRIGGER]),
    serviceName: extractStringAttribute(
      attributes,
      SemanticResourceAttributes.SERVICE_NAME,
      "unknown"
    ),
    serviceNamespace: extractStringAttribute(
      attributes,
      SemanticResourceAttributes.SERVICE_NAMESPACE,
      "unknown"
    ),
    environmentId: extractStringAttribute(
      attributes,
      SemanticInternalAttributes.ENVIRONMENT_ID,
      "unknown"
    ),
    environmentType: extractStringAttribute(
      attributes,
      SemanticInternalAttributes.ENVIRONMENT_TYPE,
      "unknown"
    ) as CreatableEventEnvironmentType,
    organizationId: extractStringAttribute(
      attributes,
      SemanticInternalAttributes.ORGANIZATION_ID,
      "unknown"
    ),
    projectId: extractStringAttribute(attributes, SemanticInternalAttributes.PROJECT_ID, "unknown"),
    projectRef: extractStringAttribute(
      attributes,
      SemanticInternalAttributes.PROJECT_REF,
      "unknown"
    ),
    runId: extractStringAttribute(attributes, SemanticInternalAttributes.RUN_ID, "unknown"),
    attemptId: extractStringAttribute(attributes, SemanticInternalAttributes.ATTEMPT_ID),
    taskSlug: extractStringAttribute(attributes, SemanticInternalAttributes.TASK_SLUG, "unknown"),
    taskPath: extractStringAttribute(attributes, SemanticInternalAttributes.TASK_PATH),
    taskExportName: extractStringAttribute(attributes, SemanticInternalAttributes.TASK_EXPORT_NAME),
    workerId: extractStringAttribute(attributes, SemanticInternalAttributes.WORKER_ID),
    workerVersion: extractStringAttribute(attributes, SemanticInternalAttributes.WORKER_VERSION),
  };
}

function pickAttributes(attributes: KeyValue[], prefix: string): KeyValue[] {
  return attributes
    .filter((attribute) => attribute.key.startsWith(prefix))
    .map((attribute) => {
      return {
        key: attribute.key.replace(`${prefix}.`, ""),
        value: attribute.value,
      };
    });
}

function convertKeyValueItemsToMap(
  attributes: KeyValue[],
  filteredKeys: string[] = [],
  prefix?: string
): Record<string, string | number | boolean | undefined> {
  return attributes.reduce(
    (map: Record<string, string | number | boolean | undefined>, attribute) => {
      if (filteredKeys.includes(attribute.key)) return map;

      map[`${prefix ? `${prefix}.` : ""}${attribute.key}`] = isStringValue(attribute.value)
        ? attribute.value.value.stringValue
        : isIntValue(attribute.value)
        ? Number(attribute.value.value.intValue)
        : isDoubleValue(attribute.value)
        ? attribute.value.value.doubleValue
        : isBoolValue(attribute.value)
        ? attribute.value.value.boolValue
        : isBytesValue(attribute.value)
        ? binaryToHex(attribute.value.value.bytesValue)
        : undefined;

      return map;
    },
    {}
  );
}

function spanLinksToEventLinks(links: Span_Link[]): CreatableEvent["links"] {
  return links.map((link) => {
    return {
      traceId: binaryToHex(link.traceId),
      spanId: binaryToHex(link.spanId),
      tracestate: link.traceState,
      properties: convertKeyValueItemsToMap(link.attributes ?? []),
    };
  });
}

function spanEventsToEventEvents(events: Span_Event[]): CreatableEvent["events"] {
  return events.map((event) => {
    return {
      name: event.name,
      time: convertUnixNanoToDate(event.timeUnixNano),
      properties: convertKeyValueItemsToMap(event.attributes ?? []),
    };
  });
}

function spanStatusToEventStatus(status: Span["status"]): CreatableEventStatus {
  if (!status) return "UNSET";

  switch (status.code) {
    case Status_StatusCode.OK: {
      return "OK";
    }
    case Status_StatusCode.ERROR: {
      return "ERROR";
    }
    case Status_StatusCode.UNSET: {
      return "UNSET";
    }
    default: {
      return "UNSET";
    }
  }
}

function spanKindToEventKind(kind: Span["kind"]): CreatableEventKind {
  switch (kind) {
    case Span_SpanKind.CLIENT: {
      return "CLIENT";
    }
    case Span_SpanKind.SERVER: {
      return "SERVER";
    }
    case Span_SpanKind.CONSUMER: {
      return "CONSUMER";
    }
    case Span_SpanKind.PRODUCER: {
      return "PRODUCER";
    }
    default: {
      return "INTERNAL";
    }
  }
}

function logLevelToEventLevel(level: SeverityNumber): CreatableEvent["level"] {
  switch (level) {
    case SeverityNumber.TRACE:
    case SeverityNumber.TRACE2:
    case SeverityNumber.TRACE3:
    case SeverityNumber.TRACE4: {
      return "TRACE";
    }
    case SeverityNumber.DEBUG:
    case SeverityNumber.DEBUG2:
    case SeverityNumber.DEBUG3:
    case SeverityNumber.DEBUG4: {
      return "DEBUG";
    }
    case SeverityNumber.INFO:
    case SeverityNumber.INFO2:
    case SeverityNumber.INFO3:
    case SeverityNumber.INFO4: {
      return "INFO";
    }
    case SeverityNumber.WARN:
    case SeverityNumber.WARN2:
    case SeverityNumber.WARN3:
    case SeverityNumber.WARN4: {
      return "WARN";
    }
    case SeverityNumber.ERROR:
    case SeverityNumber.ERROR2:
    case SeverityNumber.ERROR3:
    case SeverityNumber.ERROR4: {
      return "ERROR";
    }
    case SeverityNumber.FATAL:
    case SeverityNumber.FATAL2:
    case SeverityNumber.FATAL3:
    case SeverityNumber.FATAL4: {
      return "ERROR";
    }
    default: {
      return "INFO";
    }
  }
}

function logLevelToEventStatus(level: SeverityNumber): CreatableEventStatus {
  switch (level) {
    case SeverityNumber.TRACE:
    case SeverityNumber.TRACE2:
    case SeverityNumber.TRACE3:
    case SeverityNumber.TRACE4: {
      return "OK";
    }
    case SeverityNumber.DEBUG:
    case SeverityNumber.DEBUG2:
    case SeverityNumber.DEBUG3:
    case SeverityNumber.DEBUG4: {
      return "OK";
    }
    case SeverityNumber.INFO:
    case SeverityNumber.INFO2:
    case SeverityNumber.INFO3:
    case SeverityNumber.INFO4: {
      return "OK";
    }
    case SeverityNumber.WARN:
    case SeverityNumber.WARN2:
    case SeverityNumber.WARN3:
    case SeverityNumber.WARN4: {
      return "OK";
    }
    case SeverityNumber.ERROR:
    case SeverityNumber.ERROR2:
    case SeverityNumber.ERROR3:
    case SeverityNumber.ERROR4: {
      return "ERROR";
    }
    case SeverityNumber.FATAL:
    case SeverityNumber.FATAL2:
    case SeverityNumber.FATAL3:
    case SeverityNumber.FATAL4: {
      return "ERROR";
    }
    default: {
      return "OK";
    }
  }
}

function convertUnixNanoToDate(unixNano: bigint): Date {
  return new Date(Number(unixNano / BigInt(1_000_000)));
}

function extractStringAttribute(attributes: KeyValue[], name: string): string | undefined;
function extractStringAttribute(attributes: KeyValue[], name: string, fallback: string): string;
function extractStringAttribute(
  attributes: KeyValue[],
  name: string,
  fallback?: string
): string | undefined {
  const attribute = attributes.find((attribute) => attribute.key === name);

  return isStringValue(attribute?.value) ? attribute.value.value.stringValue : fallback;
}

function isPartialSpan(span: Span): boolean {
  if (!span.attributes) return false;

  const attribute = span.attributes.find(
    (attribute) => attribute.key === SemanticInternalAttributes.SPAN_PARTIAL
  );

  return isBoolValue(attribute?.value) ? attribute.value.value.boolValue : false;
}

function isBoolValue(
  value: AnyValue | undefined
): value is { value: { $case: "boolValue"; boolValue: boolean } } {
  if (!value) return false;

  return (value.value && value.value.$case === "boolValue")!!;
}

function isStringValue(
  value: AnyValue | undefined
): value is { value: { $case: "stringValue"; stringValue: string } } {
  if (!value) return false;

  return (value.value && value.value.$case === "stringValue")!!;
}

function isIntValue(
  value: AnyValue | undefined
): value is { value: { $case: "intValue"; intValue: bigint } } {
  if (!value) return false;

  return (value.value && value.value.$case === "intValue")!!;
}

function isDoubleValue(
  value: AnyValue | undefined
): value is { value: { $case: "doubleValue"; doubleValue: number } } {
  if (!value) return false;

  return (value.value && value.value.$case === "doubleValue")!!;
}

function isBytesValue(
  value: AnyValue | undefined
): value is { value: { $case: "bytesValue"; bytesValue: Buffer } } {
  if (!value) return false;

  return (value.value && value.value.$case === "bytesValue")!!;
}

function binaryToHex(buffer: Buffer): string;
function binaryToHex(buffer: Buffer | undefined): string | undefined;
function binaryToHex(buffer: Buffer | undefined): string | undefined {
  if (!buffer) return undefined;

  return Buffer.from(Array.from(buffer)).toString("hex");
}

export const otlpExporter = new OTLPExporter(eventRepository);
