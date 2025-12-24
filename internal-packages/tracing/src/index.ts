import {
  Meter,
  type Span,
  type SpanOptions,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import { type Logger, SeverityNumber } from "@opentelemetry/api-logs";
import { flattenAttributes } from "@trigger.dev/core/v3/utils/flattenAttributes";

export * from "@opentelemetry/semantic-conventions";

export type {
  Tracer,
  Attributes,
  Meter,
  Counter,
  UpDownCounter,
  ObservableGauge,
  ObservableCounter,
  ObservableUpDownCounter,
  MetricOptions,
  Gauge,
  Histogram,
  ObservableResult,
} from "@opentelemetry/api";

import {
  trace,
  context,
  propagation,
  SpanKind,
  metrics,
  ValueType,
  ROOT_CONTEXT,
} from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
export {
  trace,
  context,
  propagation,
  type Span,
  SpanKind,
  type SpanOptions,
  SpanStatusCode,
  metrics,
  ValueType,
  ROOT_CONTEXT,
  type Context,
};

export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

export function getMeter(name: string): Meter {
  return metrics.getMeter(name);
}

export async function startSpan<T>(
  tracer: Tracer | undefined,
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions
): Promise<T> {
  tracer ??= getTracer("default");

  return tracer.startActiveSpan(name, options ?? {}, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      } else if (typeof error === "string") {
        span.recordException(new Error(error));
      } else {
        span.recordException(new Error(String(error)));
      }

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });

      throw error;
    } finally {
      span.end();
    }
  });
}

export function recordSpanError(span: Span, error: Error) {
  span.recordException(error);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error.message,
  });
}

export async function emitDebugLog(
  logger: Logger,
  message: string,
  params: Record<string, unknown> = {}
) {
  logger.emit({
    severityNumber: SeverityNumber.DEBUG,
    body: message,
    attributes: { ...flattenAttributes(params, "params") },
  });
}

export async function emitInfoLog(
  logger: Logger,
  message: string,
  params: Record<string, unknown> = {}
) {
  logger.emit({
    severityNumber: SeverityNumber.INFO,
    body: message,
    attributes: { ...flattenAttributes(params, "params") },
  });
}

export async function emitErrorLog(
  logger: Logger,
  message: string,
  params: Record<string, unknown> = {}
) {
  logger.emit({
    severityNumber: SeverityNumber.ERROR,
    body: message,
    attributes: { ...flattenAttributes(params, "params") },
  });
}

export async function emitWarnLog(
  logger: Logger,
  message: string,
  params: Record<string, unknown> = {}
) {
  logger.emit({
    severityNumber: SeverityNumber.WARN,
    body: message,
    attributes: { ...flattenAttributes(params, "params") },
  });
}
