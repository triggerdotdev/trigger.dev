import {
  TraceService,
  ExportTraceServiceRequest,
  ExportTraceServiceResponse,
  ExportTracePartialSuccess,
} from "./generated/opentelemetry/proto/collector/trace/v1/trace_service";

import {
  LogsService,
  ExportLogsServiceRequest,
  ExportLogsServiceResponse,
  ExportLogsPartialSuccess,
} from "./generated/opentelemetry/proto/collector/logs/v1/logs_service";

import { Resource } from "./generated/opentelemetry/proto/resource/v1/resource";
import {
  ResourceSpans,
  Span,
  SpanFlags,
  ScopeSpans,
  Span_SpanKind,
  Status,
  Status_StatusCode,
  Span_Event,
  Span_Link,
} from "./generated/opentelemetry/proto/trace/v1/trace";
import type {
  KeyValue,
  KeyValueList,
  AnyValue,
} from "./generated/opentelemetry/proto/common/v1/common";
import {
  LogRecord,
  ResourceLogs,
  ScopeLogs,
  SeverityNumber,
} from "./generated/opentelemetry/proto/logs/v1/logs";

export {
  Resource,
  Span,
  SpanFlags,
  ResourceSpans,
  ScopeSpans,
  type KeyValue,
  type KeyValueList,
  type AnyValue,
  Span_SpanKind,
  Status,
  Status_StatusCode,
  Span_Event,
  Span_Link,
  ResourceLogs,
  ScopeLogs,
  LogRecord,
  SeverityNumber,
};

export {
  type TraceService,
  ExportTraceServiceRequest,
  ExportTraceServiceResponse,
  ExportTracePartialSuccess,
};

export {
  type LogsService,
  ExportLogsServiceRequest,
  ExportLogsServiceResponse,
  ExportLogsPartialSuccess,
};
