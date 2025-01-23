import { Span, SpanOptions, SpanStatusCode, Tracer } from "@opentelemetry/api";
import { Logger, SeverityNumber } from "@opentelemetry/api-logs";
import { flattenAttributes } from "@trigger.dev/core/v3/utils/flattenAttributes";

export async function startSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions
): Promise<T> {
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
