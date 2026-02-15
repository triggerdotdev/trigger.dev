import { trace, Tracer } from "@opentelemetry/api";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3";
import {
  AnyValue,
  ExportLogsServiceRequest,
  ExportLogsServiceResponse,
  ExportMetricsServiceRequest,
  ExportMetricsServiceResponse,
  ExportTraceServiceRequest,
  ExportTraceServiceResponse,
  KeyValue,
  ResourceLogs,
  ResourceMetrics,
  ResourceSpans,
  SeverityNumber,
  Span,
  Span_Event,
  Span_SpanKind,
  Status_StatusCode,
} from "@trigger.dev/otlp-importer";
import type { MetricsV1Input } from "@internal/clickhouse";
import { logger } from "~/services/logger.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { DynamicFlushScheduler } from "./dynamicFlushScheduler.server";
import { ClickhouseEventRepository } from "./eventRepository/clickhouseEventRepository.server";
import {
  clickhouseEventRepository,
  clickhouseEventRepositoryV2,
} from "./eventRepository/clickhouseEventRepositoryInstance.server";
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
import { detectBadJsonStrings } from "~/utils/detectBadJsonStrings";
import { singleton } from "~/utils/singleton";

class OTLPExporter {
  private _tracer: Tracer;

  constructor(
    private readonly _eventRepository: EventRepository,
    private readonly _clickhouseEventRepository: ClickhouseEventRepository,
    private readonly _clickhouseEventRepositoryV2: ClickhouseEventRepository,
    private readonly _metricsFlushScheduler: DynamicFlushScheduler<MetricsV1Input>,
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

  async exportMetrics(
    request: ExportMetricsServiceRequest
  ): Promise<ExportMetricsServiceResponse> {
    return await startSpan(this._tracer, "exportMetrics", async (span) => {
      const rows = this.#filterResourceMetrics(request.resourceMetrics).flatMap(
        (resourceMetrics) => {
          return convertMetricsToClickhouseRows(
            resourceMetrics,
            this._spanAttributeValueLengthLimit
          );
        }
      );

      span.setAttribute("metric_row_count", rows.length);

      if (rows.length > 0) {
        this._metricsFlushScheduler.addToBatch(rows);
      }

      return ExportMetricsServiceResponse.create();
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

    if (store === "clickhouse_v2") {
      return this._clickhouseEventRepositoryV2;
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

  #filterResourceMetrics(resourceMetrics: ResourceMetrics[]): ResourceMetrics[] {
    return resourceMetrics.filter((rm) => {
      const triggerAttribute = rm.resource?.attributes.find(
        (attribute) => attribute.key === SemanticInternalAttributes.TRIGGER
      );

      if (!triggerAttribute) return false;

      return isBoolValue(triggerAttribute.value) ? triggerAttribute.value.boolValue : false;
    });
  }
}

function convertLogsToCreateableEvents(
  resourceLog: ResourceLogs,
  spanAttributeValueLengthLimit: number
): { events: Array<CreateEventInput>; taskEventStore: string } {
  const resourceAttributes = resourceLog.resource?.attributes ?? [];

  const resourceProperties = extractEventProperties(resourceAttributes);

  const userDefinedResourceAttributes = truncateAttributes(
    convertKeyValueItemsToMap(resourceAttributes ?? [], [], undefined, [
      SemanticInternalAttributes.USAGE,
      SemanticInternalAttributes.SPAN,
      SemanticInternalAttributes.METADATA,
      SemanticInternalAttributes.STYLE,
      SemanticInternalAttributes.METRIC_EVENTS,
      SemanticInternalAttributes.TRIGGER,
      "process",
      "sdk",
      "service",
      "ctx",
      "cli",
      "cloud",
    ]),
    spanAttributeValueLengthLimit
  );

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

        const properties =
          truncateAttributes(
            convertKeyValueItemsToMap(log.attributes ?? [], [], undefined, [
              SemanticInternalAttributes.USAGE,
              SemanticInternalAttributes.SPAN,
              SemanticInternalAttributes.METADATA,
              SemanticInternalAttributes.STYLE,
              SemanticInternalAttributes.METRIC_EVENTS,
              SemanticInternalAttributes.TRIGGER,
            ]),
            spanAttributeValueLengthLimit
          ) ?? {};

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
          resourceProperties: userDefinedResourceAttributes,
          style: convertKeyValueItemsToMap(
            pickAttributes(log.attributes ?? [], SemanticInternalAttributes.STYLE),
            []
          ),
          metadata: logProperties.metadata ?? resourceProperties.metadata ?? {},
          environmentId:
            logProperties.environmentId ?? resourceProperties.environmentId ?? "unknown",
          environmentType: "DEVELOPMENT" as const, // We've deprecated this but we need to keep it for backwards compatibility
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

  const userDefinedResourceAttributes = truncateAttributes(
    convertKeyValueItemsToMap(resourceAttributes ?? [], [], undefined, [
      SemanticInternalAttributes.USAGE,
      SemanticInternalAttributes.SPAN,
      SemanticInternalAttributes.METADATA,
      SemanticInternalAttributes.STYLE,
      SemanticInternalAttributes.METRIC_EVENTS,
      SemanticInternalAttributes.TRIGGER,
      "process",
      "sdk",
      "service",
      "ctx",
      "cli",
      "cloud",
    ]),
    spanAttributeValueLengthLimit
  );

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

        const properties =
          truncateAttributes(
            convertKeyValueItemsToMap(span.attributes ?? [], [], undefined, [
              SemanticInternalAttributes.USAGE,
              SemanticInternalAttributes.SPAN,
              SemanticInternalAttributes.METADATA,
              SemanticInternalAttributes.STYLE,
              SemanticInternalAttributes.METRIC_EVENTS,
              SemanticInternalAttributes.TRIGGER,
            ]),
            spanAttributeValueLengthLimit
          ) ?? {};

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
          resourceProperties: userDefinedResourceAttributes,
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

function floorToTenSecondBucket(timeUnixNano: bigint | number): string {
  const epochMs = Number(BigInt(timeUnixNano) / BigInt(1_000_000));
  const flooredMs = Math.floor(epochMs / 10_000) * 10_000;
  const date = new Date(flooredMs);
  // Format as ClickHouse DateTime: YYYY-MM-DD HH:MM:SS
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function convertMetricsToClickhouseRows(
  resourceMetrics: ResourceMetrics,
  spanAttributeValueLengthLimit: number
): MetricsV1Input[] {
  const resourceAttributes = resourceMetrics.resource?.attributes ?? [];
  const resourceProperties = extractEventProperties(resourceAttributes);

  const organizationId = resourceProperties.organizationId ?? "unknown";
  const projectId = resourceProperties.projectId ?? "unknown";
  const environmentId = resourceProperties.environmentId ?? "unknown";
  const resourceCtx = {
    taskSlug: resourceProperties.taskSlug,
    runId: resourceProperties.runId,
    attemptNumber: resourceProperties.attemptNumber,
    machineId: extractStringAttribute(resourceAttributes, SemanticInternalAttributes.MACHINE_ID),
    workerId: extractStringAttribute(resourceAttributes, SemanticInternalAttributes.WORKER_ID),
    workerVersion: extractStringAttribute(
      resourceAttributes,
      SemanticInternalAttributes.WORKER_VERSION
    ),
  };

  const rows: MetricsV1Input[] = [];

  for (const scopeMetrics of resourceMetrics.scopeMetrics) {
    for (const metric of scopeMetrics.metrics) {
      const metricName = metric.name;

      // Process gauge data points
      if (metric.gauge) {
        for (const dp of metric.gauge.dataPoints) {
          const value: number =
            dp.asDouble !== undefined ? dp.asDouble : dp.asInt !== undefined ? Number(dp.asInt) : 0;
          const resolved = resolveDataPointContext(dp.attributes ?? [], resourceCtx);

          rows.push({
            organization_id: organizationId,
            project_id: projectId,
            environment_id: environmentId,
            metric_name: metricName,
            metric_type: "gauge",
            metric_subject: resolved.machineId ?? "unknown",
            bucket_start: floorToTenSecondBucket(dp.timeUnixNano),
            count: 0,
            sum_value: 0,
            max_value: value,
            min_value: value,
            last_value: value,
            attributes: resolved.attributes,
          });
        }
      }

      // Process sum data points
      if (metric.sum) {
        for (const dp of metric.sum.dataPoints) {
          const value: number =
            dp.asDouble !== undefined ? dp.asDouble : dp.asInt !== undefined ? Number(dp.asInt) : 0;
          const resolved = resolveDataPointContext(dp.attributes ?? [], resourceCtx);

          rows.push({
            organization_id: organizationId,
            project_id: projectId,
            environment_id: environmentId,
            metric_name: metricName,
            metric_type: "sum",
            metric_subject: resolved.machineId ?? "unknown",
            bucket_start: floorToTenSecondBucket(dp.timeUnixNano),
            count: 1,
            sum_value: value,
            max_value: value,
            min_value: value,
            last_value: value,
            attributes: resolved.attributes,
          });
        }
      }

      // Process histogram data points
      if (metric.histogram) {
        for (const dp of metric.histogram.dataPoints) {
          const resolved = resolveDataPointContext(dp.attributes ?? [], resourceCtx);
          const count = Number(dp.count);
          const sum = dp.sum ?? 0;
          const max = dp.max ?? 0;
          const min = dp.min ?? 0;

          rows.push({
            organization_id: organizationId,
            project_id: projectId,
            environment_id: environmentId,
            metric_name: metricName,
            metric_type: "histogram",
            metric_subject: resolved.machineId ?? "unknown",
            bucket_start: floorToTenSecondBucket(dp.timeUnixNano),
            count,
            sum_value: sum,
            max_value: max,
            min_value: min,
            last_value: count > 0 ? sum / count : 0,
            attributes: resolved.attributes,
          });
        }
      }
    }
  }

  return rows;
}

// Prefixes injected by TaskContextMetricExporter — these are extracted into
// the nested `trigger` key and should not appear as top-level user attributes.
const INTERNAL_METRIC_ATTRIBUTE_PREFIXES = ["ctx.", "worker."];

interface ResourceContext {
  taskSlug: string | undefined;
  runId: string | undefined;
  attemptNumber: number | undefined;
  machineId: string | undefined;
  workerId: string | undefined;
  workerVersion: string | undefined;
}

function resolveDataPointContext(
  dpAttributes: KeyValue[],
  resourceCtx: ResourceContext
): {
  machineId: string | undefined;
  attributes: Record<string, unknown>;
} {
  const runId =
    resourceCtx.runId ??
    extractStringAttribute(dpAttributes, SemanticInternalAttributes.RUN_ID);
  const taskSlug =
    resourceCtx.taskSlug ??
    extractStringAttribute(dpAttributes, SemanticInternalAttributes.TASK_SLUG);
  const attemptNumber =
    resourceCtx.attemptNumber ??
    extractNumberAttribute(dpAttributes, SemanticInternalAttributes.ATTEMPT_NUMBER);
  const machineId =
    resourceCtx.machineId ??
    extractStringAttribute(dpAttributes, SemanticInternalAttributes.MACHINE_ID);
  const workerId =
    resourceCtx.workerId ??
    extractStringAttribute(dpAttributes, SemanticInternalAttributes.WORKER_ID);
  const workerVersion =
    resourceCtx.workerVersion ??
    extractStringAttribute(dpAttributes, SemanticInternalAttributes.WORKER_VERSION);
  const machineName = extractStringAttribute(
    dpAttributes,
    SemanticInternalAttributes.MACHINE_PRESET_NAME
  );
  const environmentType = extractStringAttribute(
    dpAttributes,
    SemanticInternalAttributes.ENVIRONMENT_TYPE
  );

  // Build the trigger context object with only defined values
  const trigger: Record<string, string | number> = {};
  if (runId) trigger.run_id = runId;
  if (taskSlug) trigger.task_slug = taskSlug;
  if (attemptNumber !== undefined) trigger.attempt_number = attemptNumber;
  if (machineId) trigger.machine_id = machineId;
  if (machineName) trigger.machine_name = machineName;
  if (workerId) trigger.worker_id = workerId;
  if (workerVersion) trigger.worker_version = workerVersion;
  if (environmentType) trigger.environment_type = environmentType;

  // Build user attributes, filtering out internal ctx/worker keys
  const result: Record<string, unknown> = {};

  if (Object.keys(trigger).length > 0) {
    result.trigger = trigger;
  }

  for (const attr of dpAttributes) {
    if (INTERNAL_METRIC_ATTRIBUTE_PREFIXES.some((prefix) => attr.key.startsWith(prefix))) {
      continue;
    }

    if (isStringValue(attr.value)) {
      result[attr.key] = attr.value.stringValue;
    } else if (isIntValue(attr.value)) {
      result[attr.key] = Number(attr.value.intValue);
    } else if (isDoubleValue(attr.value)) {
      result[attr.key] = attr.value.doubleValue;
    } else if (isBoolValue(attr.value)) {
      result[attr.key] = attr.value.boolValue;
    }
  }

  return { machineId, attributes: result };
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

function truncateAttributes(
  attributes: Record<string, string | number | boolean | undefined> | undefined,
  maximumLength: number = 1024
): Record<string, string | number | boolean | undefined> | undefined {
  if (!attributes) return undefined;

  const truncatedAttributes: Record<string, string | number | boolean | undefined> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (!key) continue;

    if (typeof value === "string") {
      truncatedAttributes[key] = truncateAndDetectUnpairedSurrogate(value, maximumLength);
    } else {
      truncatedAttributes[key] = value;
    }
  }

  return truncatedAttributes;
}

function truncateAndDetectUnpairedSurrogate(str: string, maximumLength: number): string {
  const truncatedString = smartTruncateString(str, maximumLength);

  if (hasUnpairedSurrogateAtEnd(truncatedString)) {
    return smartTruncateString(truncatedString, [...truncatedString].length - 1);
  }

  return truncatedString;
}

const ASCII_ONLY_REGEX = /^[\p{ASCII}]*$/u;

function smartTruncateString(str: string, maximumLength: number): string {
  if (!str) return "";
  if (str.length <= maximumLength) return str;

  const checkLength = Math.min(str.length, maximumLength * 2 + 2);

  if (ASCII_ONLY_REGEX.test(str.slice(0, checkLength))) {
    return str.slice(0, maximumLength);
  }

  return [...str.slice(0, checkLength)].slice(0, maximumLength).join("");
}

function hasUnpairedSurrogateAtEnd(str: string): boolean {
  if (str.length === 0) return false;

  const lastCode = str.charCodeAt(str.length - 1);

  // Check if last character is an unpaired high surrogate
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    return true; // High surrogate at end = unpaired
  }

  // Check if last character is an unpaired low surrogate
  if (lastCode >= 0xdc00 && lastCode <= 0xdfff) {
    // Low surrogate is only valid if preceded by high surrogate
    if (str.length === 1) return true; // Single low surrogate

    const secondLastCode = str.charCodeAt(str.length - 2);
    if (secondLastCode < 0xd800 || secondLastCode > 0xdbff) {
      return true; // Low surrogate not preceded by high surrogate
    }
  }

  return false;
}

export const otlpExporter = singleton("otlpExporter", initializeOTLPExporter);

function initializeOTLPExporter() {
  const metricsFlushScheduler = new DynamicFlushScheduler<MetricsV1Input>({
    batchSize: env.METRICS_CLICKHOUSE_BATCH_SIZE,
    flushInterval: env.METRICS_CLICKHOUSE_FLUSH_INTERVAL_MS,
    callback: async (_flushId, batch) => {
      await clickhouseClient.metrics.insert(batch);
    },
    minConcurrency: 1,
    maxConcurrency: env.METRICS_CLICKHOUSE_MAX_CONCURRENCY,
    loadSheddingEnabled: false,
  });

  return new OTLPExporter(
    eventRepository,
    clickhouseEventRepository,
    clickhouseEventRepositoryV2,
    metricsFlushScheduler,
    process.env.OTLP_EXPORTER_VERBOSE === "1",
    process.env.SERVER_OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT
      ? parseInt(process.env.SERVER_OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT, 10)
      : 8192
  );
}
