import type { Span, SpanOptions, Tracer } from "@opentelemetry/api";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {} from "@opentelemetry/api-logs";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { attributesFromAuthenticatedEnv } from "./tracer.server";

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

export async function startSpanWithEnv<T>(
  tracer: Tracer,
  name: string,
  env: AuthenticatedEnvironment,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions
): Promise<T> {
  return startSpan(tracer, name, fn, {
    ...options,
    attributes: {
      ...attributesFromAuthenticatedEnv(env),
      ...options?.attributes,
    },
    kind: SpanKind.SERVER,
  });
}
