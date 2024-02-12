import {
  ExportTracePartialSuccess,
  ExportTraceServiceRequest,
  ExportTraceServiceResponse,
} from "./generated/opentelemetry/proto/collector/trace/v1/trace_service";

import {
  ExportLogsPartialSuccess,
  ExportLogsServiceRequest,
  ExportLogsServiceResponse,
} from "./generated/opentelemetry/proto/collector/logs/v1/logs_service";

import type {
  AnyValue,
  KeyValue,
  KeyValueList,
} from "./generated/opentelemetry/proto/common/v1/common";
import {
  LogRecord,
  ResourceLogs,
  ScopeLogs,
  SeverityNumber,
} from "./generated/opentelemetry/proto/logs/v1/logs";
import { Resource } from "./generated/opentelemetry/proto/resource/v1/resource";
import {
  ResourceSpans,
  ScopeSpans,
  Span,
  SpanFlags,
  Span_Event,
  Span_Link,
  Span_SpanKind,
  Status,
  Status_StatusCode,
} from "./generated/opentelemetry/proto/trace/v1/trace";

export {
  LogRecord,
  Resource,
  ResourceLogs,
  ResourceSpans,
  ScopeLogs,
  ScopeSpans,
  SeverityNumber,
  Span,
  SpanFlags,
  Span_Event,
  Span_Link,
  Span_SpanKind,
  Status,
  Status_StatusCode,
  type AnyValue,
  type KeyValue,
  type KeyValueList,
};

export { ExportTracePartialSuccess, ExportTraceServiceRequest, ExportTraceServiceResponse };

export { ExportLogsPartialSuccess, ExportLogsServiceRequest, ExportLogsServiceResponse };
