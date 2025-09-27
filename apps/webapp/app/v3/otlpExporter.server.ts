import { trace, Tracer } from "@opentelemetry/api";
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
  Span_SpanKind,
  Status_StatusCode,
} from "@trigger.dev/otlp-importer";
import { logger } from "~/services/logger.server";
import { ClickhouseEventRepository } from "./eventRepository/clickhouseEventRepository.server";
import { clickhouseEventRepository } from "./eventRepository/clickhouseEventRepositoryInstance.server";
import { generateSpanId } from "./eventRepository/common.server";
import { EventRepository, eventRepository } from "./eventRepository/eventRepository.server";
import type {
  CreatableEventKind,
  CreatableEventStatus,
  CreateEventInput,
  IEventRepository,
} from "./eventRepository/eventRepository.types";
import { startSpan } from "./tracing.server";
import { enrichCreatableEvents } from "./utils/enrichCreatableEvents.server";
import { env } from "~/env.server";

class OTLPExporter {
  private _tracer: Tracer;

  constructor(
    private readonly _eventRepository: EventRepository,
    private readonly _clickhouseEventRepository: ClickhouseEventRepository,
    private readonly _verbose: boolean,
    private readonly _spanAttributeValueLengthLimit: number
  ) {
    this._tracer = trace.getTracer("otlp-exporter");
  }

  async exportTraces(request: ExportTraceServiceRequest): Promise<ExportTraceServiceResponse> {
    return await startSpan(this._tracer, "exportTraces", async (span) => {
      this.#logExportTracesVerbose(request);

      const eventsWithStores = this.#filterResourceSpans(request.resourceSpans).flatMap(
        (resourceSpan) => {
          return convertSpansToCreateableEvents(resourceSpan, this._spanAttributeValueLengthLimit);
        }
      );

      const eventCount = await this.#exportEvents(eventsWithStores);

      span.setAttribute("event_count", eventCount);

      return ExportTraceServiceResponse.create();
    });
  }

  async exportLogs(request: ExportLogsServiceRequest): Promise<ExportLogsServiceResponse> {
    return await startSpan(this._tracer, "exportLogs", async (span) => {
      this.#logExportLogsVerbose(request);

      const eventsWithStores = this.#filterResourceLogs(request.resourceLogs).flatMap(
        (resourceLog) => {
          return convertLogsToCreateableEvents(resourceLog, this._spanAttributeValueLengthLimit);
        }
      );

      const eventCount = await this.#exportEvents(eventsWithStores);

      span.setAttribute("event_count", eventCount);

      return ExportLogsServiceResponse.create();
    });
  }

  async #exportEvents(
    eventsWithStores: { events: Array<CreateEventInput>; taskEventStore: string }[]
  ) {
    const eventsGroupedByStore = eventsWithStores.reduce((acc, { events, taskEventStore }) => {
      acc[taskEventStore] = acc[taskEventStore] || [];
      acc[taskEventStore].push(...events);
      return acc;
    }, {} as Record<string, Array<CreateEventInput>>);

    let eventCount = 0;

    for (const [store, events] of Object.entries(eventsGroupedByStore)) {
      const eventRepository = this.#getEventRepositoryForStore(store);

      const enrichedEvents = enrichCreatableEvents(events);

      this.#logEventsVerbose(enrichedEvents, `exportEvents ${store}`);

      eventCount += enrichedEvents.length;

      await eventRepository.insertMany(enrichedEvents);
    }

    return eventCount;
  }

  #getEventRepositoryForStore(store: string): IEventRepository {
    if (store === "clickhouse") {
      return this._clickhouseEventRepository;
    }

    return this._eventRepository;
  }

  #logEventsVerbose(events: CreateEventInput[], prefix: string) {
    if (!this._verbose) return;

    events.forEach((event) => {
      logger.debug(`Exporting ${prefix} event`, { event });
    });
  }

  #logExportTracesVerbose(request: ExportTraceServiceRequest) {
    if (!this._verbose) return;

    logger.debug("Exporting traces", {
      resourceSpans: request.resourceSpans.length,
      totalSpans: request.resourceSpans.reduce(
        (acc, resourceSpan) => acc + resourceSpan.scopeSpans.length,
        0
      ),
    });
  }

  #logExportLogsVerbose(request: ExportLogsServiceRequest) {
    if (!this._verbose) return;

    logger.debug("Exporting logs", {
      resourceLogs: request.resourceLogs.length,
      totalLogs: request.resourceLogs.reduce(
        (acc, resourceLog) =>
          acc +
          resourceLog.scopeLogs.reduce((acc, scopeLog) => acc + scopeLog.logRecords.length, 0),
        0
      ),
    });
  }

  #filterResourceSpans(
    resourceSpans: ExportTraceServiceRequest["resourceSpans"]
  ): ExportTraceServiceRequest["resourceSpans"] {
    return resourceSpans.filter((resourceSpan) => {
      const triggerAttribute = resourceSpan.resource?.attributes.find(
        (attribute) => attribute.key === SemanticInternalAttributes.TRIGGER
      );

      const executionEnvironmentAttribute = resourceSpan.resource?.attributes.find(
        (attribute) => attribute.key === SemanticInternalAttributes.EXECUTION_ENVIRONMENT
      );

      if (!triggerAttribute && !executionEnvironmentAttribute) {
        logger.debug("Skipping resource span without trigger attribute", {
          attributes: resourceSpan.resource?.attributes,
          spans: resourceSpan.scopeSpans.flatMap((scopeSpan) => scopeSpan.spans),
        });

        return true; // go ahead and let this resource span through
      }

      const executionEnvironment = isStringValue(executionEnvironmentAttribute?.value)
        ? executionEnvironmentAttribute.value.stringValue
        : undefined;

      if (executionEnvironment === "trigger") {
        return true; // go ahead and let this resource span through
      }

      return isBoolValue(triggerAttribute?.value) ? triggerAttribute.value.boolValue : false;
    });
  }

  #filterResourceLogs(
    resourceLogs: ExportLogsServiceRequest["resourceLogs"]
  ): ExportLogsServiceRequest["resourceLogs"] {
    return resourceLogs.filter((resourceLog) => {
      const attribute = resourceLog.resource?.attributes.find(
        (attribute) => attribute.key === SemanticInternalAttributes.TRIGGER
      );

      if (!attribute) return false;

      return isBoolValue(attribute.value) ? attribute.value.boolValue : false;
    });
  }
}

function convertLogsToCreateableEvents(
  resourceLog: ResourceLogs,
  spanAttributeValueLengthLimit: number
): { events: Array<CreateEventInput>; taskEventStore: string } {
  const resourceAttributes = resourceLog.resource?.attributes ?? [];

  const resourceProperties = extractEventProperties(resourceAttributes);

  const taskEventStore =
    extractStringAttribute(resourceAttributes, [SemanticInternalAttributes.TASK_EVENT_STORE]) ??
    env.EVENT_REPOSITORY_DEFAULT_STORE;

  const events = resourceLog.scopeLogs.flatMap((scopeLog) => {
    return scopeLog.logRecords
      .map((log) => {
        const logLevel = logLevelToEventLevel(log.severityNumber);

        if (!log.traceId || !log.spanId) {
          return;
        }

        const logProperties = extractEventProperties(
          log.attributes ?? [],
          SemanticInternalAttributes.METADATA
        );

        const properties = {
          ...convertKeyValueItemsToMap(
            truncateAttributes(log.attributes ?? [], spanAttributeValueLengthLimit),
            [],
            undefined,
            [
              SemanticInternalAttributes.USAGE,
              SemanticInternalAttributes.SPAN,
              SemanticInternalAttributes.METADATA,
              SemanticInternalAttributes.STYLE,
              SemanticInternalAttributes.METRIC_EVENTS,
              SemanticInternalAttributes.TRIGGER,
            ]
          ),
        };

        return {
          traceId: binaryToHex(log.traceId),
          spanId: generateSpanId(),
          parentId: binaryToHex(log.spanId),
          message: isStringValue(log.body)
            ? log.body.stringValue.slice(0, 4096)
            : `${log.severityText} log`,
          isPartial: false,
          kind: "INTERNAL" as const,
          level: logLevelToEventLevel(log.severityNumber),
          isError: logLevel === "ERROR",
          status: logLevelToEventStatus(log.severityNumber),
          startTime: log.timeUnixNano,
          properties,
          style: convertKeyValueItemsToMap(
            pickAttributes(log.attributes ?? [], SemanticInternalAttributes.STYLE),
            []
          ),
          metadata: logProperties.metadata ?? resourceProperties.metadata ?? {},
          environmentId:
            logProperties.environmentId ?? resourceProperties.environmentId ?? "unknown",
          environmentType: "DEVELOPMENT" as const,
          organizationId:
            logProperties.organizationId ?? resourceProperties.organizationId ?? "unknown",
          projectId: logProperties.projectId ?? resourceProperties.projectId ?? "unknown",
          runId: logProperties.runId ?? resourceProperties.runId ?? "unknown",
          taskSlug: logProperties.taskSlug ?? resourceProperties.taskSlug ?? "unknown",
          attemptNumber:
            extractNumberAttribute(
              log.attributes ?? [],
              [SemanticInternalAttributes.METADATA, SemanticInternalAttributes.ATTEMPT_NUMBER].join(
                "."
              )
            ) ?? resourceProperties.attemptNumber,
        };
      })
      .filter(Boolean);
  });

  return { events, taskEventStore };
}

function convertSpansToCreateableEvents(
  resourceSpan: ResourceSpans,
  spanAttributeValueLengthLimit: number
): { events: Array<CreateEventInput>; taskEventStore: string } {
  const resourceAttributes = resourceSpan.resource?.attributes ?? [];

  const resourceProperties = extractEventProperties(resourceAttributes);

  const taskEventStore =
    extractStringAttribute(resourceAttributes, [SemanticInternalAttributes.TASK_EVENT_STORE]) ??
    env.EVENT_REPOSITORY_DEFAULT_STORE;

  const events = resourceSpan.scopeSpans.flatMap((scopeSpan) => {
    return scopeSpan.spans
      .map((span) => {
        const isPartial = isPartialSpan(span);

        if (!span.traceId || !span.spanId) {
          return;
        }

        const spanProperties = extractEventProperties(
          span.attributes ?? [],
          SemanticInternalAttributes.METADATA
        );

        const properties = {
          ...convertKeyValueItemsToMap(
            truncateAttributes(span.attributes ?? [], spanAttributeValueLengthLimit),
            [],
            undefined,
            [
              SemanticInternalAttributes.USAGE,
              SemanticInternalAttributes.SPAN,
              SemanticInternalAttributes.METADATA,
              SemanticInternalAttributes.STYLE,
              SemanticInternalAttributes.METRIC_EVENTS,
              SemanticInternalAttributes.TRIGGER,
            ]
          ),
        };

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
          isError: span.status?.code === Status_StatusCode.ERROR,
          kind: spanKindToEventKind(span.kind),
          level: "TRACE" as const,
          status: spanStatusToEventStatus(span.status),
          startTime: span.startTimeUnixNano,
          events: spanEventsToEventEvents(span.events ?? []),
          duration: span.endTimeUnixNano - span.startTimeUnixNano,
          properties,
          style: convertKeyValueItemsToMap(
            pickAttributes(span.attributes ?? [], SemanticInternalAttributes.STYLE),
            []
          ),
          metadata: spanProperties.metadata ?? resourceProperties.metadata ?? {},
          environmentId:
            spanProperties.environmentId ?? resourceProperties.environmentId ?? "unknown",
          environmentType: "DEVELOPMENT" as const,
          organizationId:
            spanProperties.organizationId ?? resourceProperties.organizationId ?? "unknown",
          projectId: spanProperties.projectId ?? resourceProperties.projectId ?? "unknown",
          runId: spanProperties.runId ?? resourceProperties.runId ?? "unknown",
          taskSlug: spanProperties.taskSlug ?? resourceProperties.taskSlug ?? "unknown",
          attemptNumber:
            extractNumberAttribute(
              span.attributes ?? [],
              [SemanticInternalAttributes.METADATA, SemanticInternalAttributes.ATTEMPT_NUMBER].join(
                "."
              )
            ) ?? resourceProperties.attemptNumber,
        };
      })
      .filter(Boolean);
  });

  return { events, taskEventStore };
}

function extractEventProperties(attributes: KeyValue[], prefix?: string) {
  return {
    metadata: convertSelectedKeyValueItemsToMap(attributes, [SemanticInternalAttributes.METADATA]),
    environmentId: extractStringAttribute(attributes, [
      prefix,
      SemanticInternalAttributes.ENVIRONMENT_ID,
    ]),
    organizationId: extractStringAttribute(attributes, [
      prefix,
      SemanticInternalAttributes.ORGANIZATION_ID,
    ]),
    projectId: extractStringAttribute(attributes, [prefix, SemanticInternalAttributes.PROJECT_ID]),
    runId: extractStringAttribute(attributes, [prefix, SemanticInternalAttributes.RUN_ID]),
    attemptNumber: extractNumberAttribute(attributes, [
      prefix,
      SemanticInternalAttributes.ATTEMPT_NUMBER,
    ]),
    taskSlug: extractStringAttribute(attributes, [prefix, SemanticInternalAttributes.TASK_SLUG]),
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
  prefix?: string,
  filteredPrefixes: string[] = []
): Record<string, string | number | boolean | undefined> | undefined {
  if (!attributes) return;
  if (!attributes.length) return;

  let filteredAttributes = attributes.filter((attribute) => !filteredKeys.includes(attribute.key));

  if (!filteredAttributes.length) return;

  if (filteredPrefixes.length) {
    filteredAttributes = filteredAttributes.filter(
      (attribute) => !filteredPrefixes.some((prefix) => attribute.key.startsWith(prefix))
    );
  }

  if (!filteredAttributes.length) return;

  const result = filteredAttributes.reduce(
    (map: Record<string, string | number | boolean | undefined>, attribute) => {
      map[`${prefix ? `${prefix}.` : ""}${attribute.key}`] = isStringValue(attribute.value)
        ? attribute.value.stringValue
        : isIntValue(attribute.value)
        ? Number(attribute.value.intValue)
        : isDoubleValue(attribute.value)
        ? attribute.value.doubleValue
        : isBoolValue(attribute.value)
        ? attribute.value.boolValue
        : isBytesValue(attribute.value)
        ? binaryToHex(attribute.value.bytesValue)
        : undefined;

      return map;
    },
    {}
  );

  return result;
}

function convertSelectedKeyValueItemsToMap(
  attributes: KeyValue[],
  selectedPrefixes: string[] = [],
  prefix?: string
): Record<string, string | number | boolean | undefined> | undefined {
  if (!attributes) return;
  if (!attributes.length) return;

  let selectedAttributes = attributes.filter((attribute) =>
    selectedPrefixes.some((prefix) => attribute.key.startsWith(prefix))
  );

  if (!selectedAttributes.length) return;

  const result = selectedAttributes.reduce(
    (map: Record<string, string | number | boolean | undefined>, attribute) => {
      map[`${prefix ? `${prefix}.` : ""}${attribute.key}`] = isStringValue(attribute.value)
        ? attribute.value.stringValue
        : isIntValue(attribute.value)
        ? Number(attribute.value.intValue)
        : isDoubleValue(attribute.value)
        ? attribute.value.doubleValue
        : isBoolValue(attribute.value)
        ? attribute.value.boolValue
        : isBytesValue(attribute.value)
        ? binaryToHex(attribute.value.bytesValue)
        : undefined;

      return map;
    },
    {}
  );

  return result;
}

function detectPrimitiveValue(
  attributes: Record<string, string | number | boolean | undefined> | undefined,
  sentinel: string
): Record<string, string | number | boolean | undefined> | string | number | boolean | undefined {
  if (!attributes) return undefined;

  if (typeof attributes[sentinel] !== "undefined") {
    return attributes[sentinel];
  }

  return attributes;
}

function spanEventsToEventEvents(events: Span_Event[]): CreateEventInput["events"] {
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

function logLevelToEventLevel(level: SeverityNumber): CreateEventInput["level"] {
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

function convertUnixNanoToDate(unixNano: bigint | number): Date {
  return new Date(Number(BigInt(unixNano) / BigInt(1_000_000)));
}

function extractStringAttribute(
  attributes: KeyValue[],
  name: string | Array<string | undefined>
): string | undefined;
function extractStringAttribute(
  attributes: KeyValue[],
  name: string | Array<string | undefined>,
  fallback: string
): string;
function extractStringAttribute(
  attributes: KeyValue[],
  name: string | Array<string | undefined>,
  fallback?: string
): string | undefined {
  const key = Array.isArray(name) ? name.filter(Boolean).join(".") : name;

  const attribute = attributes.find((attribute) => attribute.key === key);

  if (!attribute) return fallback;

  return isStringValue(attribute?.value) ? attribute.value.stringValue : fallback;
}

function extractNumberAttribute(
  attributes: KeyValue[],
  name: string | Array<string | undefined>
): number | undefined;
function extractNumberAttribute(
  attributes: KeyValue[],
  name: string | Array<string | undefined>,
  fallback: number
): number;
function extractNumberAttribute(
  attributes: KeyValue[],
  name: string | Array<string | undefined>,
  fallback?: number
): number | undefined {
  const key = Array.isArray(name) ? name.filter(Boolean).join(".") : name;

  const attribute = attributes.find((attribute) => attribute.key === key);

  if (!attribute) return fallback;

  return isIntValue(attribute?.value) ? Number(attribute.value.intValue) : fallback;
}

function extractDoubleAttribute(
  attributes: KeyValue[],
  name: string | Array<string | undefined>
): number | undefined;
function extractDoubleAttribute(
  attributes: KeyValue[],
  name: string | Array<string | undefined>,
  fallback: number
): number;
function extractDoubleAttribute(
  attributes: KeyValue[],
  name: string | Array<string | undefined>,
  fallback?: number
): number | undefined {
  const key = Array.isArray(name) ? name.filter(Boolean).join(".") : name;

  const attribute = attributes.find((attribute) => attribute.key === key);

  if (!attribute) return fallback;

  return isDoubleValue(attribute?.value) ? Number(attribute.value.doubleValue) : fallback;
}

function extractBooleanAttribute(
  attributes: KeyValue[],
  name: string | Array<string | undefined>
): boolean | undefined;
function extractBooleanAttribute(
  attributes: KeyValue[],
  name: string | Array<string | undefined>,
  fallback: boolean
): boolean;
function extractBooleanAttribute(
  attributes: KeyValue[],
  name: string | Array<string | undefined>,
  fallback?: boolean
): boolean | undefined {
  const key = Array.isArray(name) ? name.filter(Boolean).join(".") : name;

  const attribute = attributes.find((attribute) => attribute.key === key);

  if (!attribute) return fallback;

  return isBoolValue(attribute?.value) ? attribute.value.boolValue : fallback;
}

function isPartialSpan(span: Span): boolean {
  if (!span.attributes) return false;

  const attribute = span.attributes.find(
    (attribute) => attribute.key === SemanticInternalAttributes.SPAN_PARTIAL
  );

  if (!attribute) return false;

  return isBoolValue(attribute.value) ? attribute.value.boolValue : false;
}

function isBoolValue(value: AnyValue | undefined): value is { boolValue: boolean } {
  if (!value) return false;

  return typeof value.boolValue === "boolean";
}

function isStringValue(value: AnyValue | undefined): value is { stringValue: string } {
  if (!value) return false;

  return typeof value.stringValue === "string";
}

function isIntValue(value: AnyValue | undefined): value is { intValue: bigint } {
  if (!value) return false;

  return typeof value.intValue === "number" || typeof value.intValue === "bigint";
}

function isDoubleValue(value: AnyValue | undefined): value is { doubleValue: number } {
  if (!value) return false;

  return typeof value.doubleValue === "number";
}

function isBytesValue(value: AnyValue | undefined): value is { bytesValue: Buffer } {
  if (!value) return false;

  return Buffer.isBuffer(value.bytesValue);
}

function binaryToHex(buffer: Buffer | string): string;
function binaryToHex(buffer: Buffer | string | undefined): string | undefined;
function binaryToHex(buffer: Buffer | string | undefined): string | undefined {
  if (!buffer) return undefined;
  if (typeof buffer === "string") return buffer;

  return Buffer.from(Array.from(buffer)).toString("hex");
}

function truncateAttributes(attributes: KeyValue[], maximumLength: number = 1024): KeyValue[] {
  return attributes.map((attribute) => {
    return isStringValue(attribute.value)
      ? {
          key: attribute.key,
          value: {
            stringValue: attribute.value.stringValue.slice(0, maximumLength),
          },
        }
      : attribute;
  });
}

export const otlpExporter = new OTLPExporter(
  eventRepository,
  clickhouseEventRepository,
  process.env.OTLP_EXPORTER_VERBOSE === "1",
  process.env.SERVER_OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT
    ? parseInt(process.env.SERVER_OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT, 10)
    : 8192
);
