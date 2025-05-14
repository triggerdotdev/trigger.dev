import {
  Attributes,
  Context,
  DiagConsoleLogger,
  DiagLogLevel,
  Link,
  Span,
  SpanKind,
  SpanOptions,
  SpanStatusCode,
  Tracer,
  diag,
  trace,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { type Instrumentation, registerInstrumentations } from "@opentelemetry/instrumentation";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { Resource } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  Sampler,
  SamplingDecision,
  SamplingResult,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { singleton } from "~/utils/singleton";
import { LoggerSpanExporter } from "./telemetry/loggerExporter.server";
import { logger } from "~/services/logger.server";
import { flattenAttributes } from "@trigger.dev/core/v3";

export const SEMINTATTRS_FORCE_RECORDING = "forceRecording";

class CustomWebappSampler implements Sampler {
  constructor(private readonly _baseSampler: Sampler) {}

  // Drop spans where a prisma library is the root span
  shouldSample(
    context: Context,
    traceId: string,
    name: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    const parentContext = trace.getSpanContext(context);

    // Exclude Prisma spans (adjust this logic as needed for your use case)
    if (!parentContext && name.includes("prisma")) {
      return { decision: SamplingDecision.NOT_RECORD };
    }

    // If the span has the forceRecording attribute, always record it
    if (attributes[SEMINTATTRS_FORCE_RECORDING]) {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    }

    // For all other spans, defer to the base sampler
    const result = this._baseSampler.shouldSample(
      context,
      traceId,
      name,
      spanKind,
      attributes,
      links
    );

    return result;
  }

  toString(): string {
    return `CustomWebappSampler`;
  }
}

export const { tracer, logger: otelLogger, provider } = singleton("tracer", getTracer);

export async function startActiveSpan<T>(
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

      logger.debug(`Error in span: ${name}`, { error });

      throw error;
    } finally {
      span.end();
    }
  });
}

export async function emitDebugLog(message: string, params: Record<string, unknown> = {}) {
  otelLogger.emit({
    severityNumber: SeverityNumber.DEBUG,
    body: message,
    attributes: { ...flattenAttributes(params, "params") },
  });
}

export async function emitInfoLog(message: string, params: Record<string, unknown> = {}) {
  otelLogger.emit({
    severityNumber: SeverityNumber.INFO,
    body: message,
    attributes: { ...flattenAttributes(params, "params") },
  });
}

export async function emitErrorLog(message: string, params: Record<string, unknown> = {}) {
  otelLogger.emit({
    severityNumber: SeverityNumber.ERROR,
    body: message,
    attributes: { ...flattenAttributes(params, "params") },
  });
}

export async function emitWarnLog(message: string, params: Record<string, unknown> = {}) {
  otelLogger.emit({
    severityNumber: SeverityNumber.WARN,
    body: message,
    attributes: { ...flattenAttributes(params, "params") },
  });
}

function getTracer() {
  if (env.INTERNAL_OTEL_TRACE_DISABLED === "1") {
    console.log(`🔦 Tracer disabled, returning a noop tracer`);

    return {
      tracer: trace.getTracer("trigger.dev", "3.3.12"),
      logger: logs.getLogger("trigger.dev", "3.3.12"),
      provider: new NodeTracerProvider(),
    };
  }

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const samplingRate = 1.0 / Math.max(parseInt(env.INTERNAL_OTEL_TRACE_SAMPLING_RATE, 10), 1);

  const provider = new NodeTracerProvider({
    forceFlushTimeoutMillis: 15_000,
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: env.SERVICE_NAME,
    }),
    sampler: new ParentBasedSampler({
      root: new CustomWebappSampler(new TraceIdRatioBasedSampler(samplingRate)),
    }),
    spanLimits: {
      attributeCountLimit: 1024,
    },
  });

  if (env.INTERNAL_OTEL_TRACE_EXPORTER_URL) {
    const headers = parseInternalTraceHeaders() ?? {};

    const exporter = new OTLPTraceExporter({
      url: env.INTERNAL_OTEL_TRACE_EXPORTER_URL,
      timeoutMillis: 15_000,
      headers,
    });

    provider.addSpanProcessor(
      new BatchSpanProcessor(exporter, {
        maxExportBatchSize: 512,
        scheduledDelayMillis: 1000,
        exportTimeoutMillis: 30000,
        maxQueueSize: 2048,
      })
    );

    console.log(
      `🔦 Tracer: OTLP exporter enabled to ${env.INTERNAL_OTEL_TRACE_EXPORTER_URL} (sampling = ${samplingRate})`
    );
  } else {
    if (env.INTERNAL_OTEL_TRACE_LOGGING_ENABLED === "1") {
      console.log(`🔦 Tracer: Logger exporter enabled (sampling = ${samplingRate})`);

      const loggerExporter = new LoggerSpanExporter();

      provider.addSpanProcessor(new SimpleSpanProcessor(loggerExporter));
    }
  }

  if (env.INTERNAL_OTEL_LOG_EXPORTER_URL) {
    const headers = parseInternalTraceHeaders() ?? {};

    const logExporter = new OTLPLogExporter({
      url: env.INTERNAL_OTEL_LOG_EXPORTER_URL,
      timeoutMillis: 15_000,
      headers,
    });

    const loggerProvider = new LoggerProvider({
      resource: new Resource({
        [SEMRESATTRS_SERVICE_NAME]: env.SERVICE_NAME,
      }),
      logRecordLimits: {
        attributeCountLimit: 1000,
      },
    });

    loggerProvider.addLogRecordProcessor(
      new BatchLogRecordProcessor(logExporter, {
        maxExportBatchSize: 64,
        scheduledDelayMillis: 200,
        exportTimeoutMillis: 30000,
        maxQueueSize: 512,
      })
    );

    logs.setGlobalLoggerProvider(loggerProvider);

    console.log(
      `🔦 Tracer: OTLP log exporter enabled to ${env.INTERNAL_OTEL_LOG_EXPORTER_URL} (sampling = ${samplingRate})`
    );
  }

  provider.register();

  let instrumentations: Instrumentation[] = [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
  ];

  if (env.INTERNAL_OTEL_TRACE_INSTRUMENT_PRISMA_ENABLED === "1") {
    instrumentations.push(new PrismaInstrumentation());
  }

  registerInstrumentations({
    tracerProvider: provider,
    loggerProvider: logs.getLoggerProvider(),
    instrumentations,
  });

  return {
    tracer: provider.getTracer("trigger.dev", "3.3.12"),
    logger: logs.getLogger("trigger.dev", "3.3.12"),
    provider,
  };
}

const SemanticEnvResources = {
  ENV_ID: "$trigger.env.id",
  ENV_TYPE: "$trigger.env.type",
  ENV_SLUG: "$trigger.env.slug",
  ORG_ID: "$trigger.org.id",
  ORG_SLUG: "$trigger.org.slug",
  ORG_TITLE: "$trigger.org.title",
  PROJECT_ID: "$trigger.project.id",
  PROJECT_NAME: "$trigger.project.name",
  USER_ID: "$trigger.user.id",
};

export function attributesFromAuthenticatedEnv(env: AuthenticatedEnvironment): Attributes {
  return {
    [SemanticEnvResources.ENV_ID]: env.id,
    [SemanticEnvResources.ENV_TYPE]: env.type,
    [SemanticEnvResources.ENV_SLUG]: env.slug,
    [SemanticEnvResources.ORG_ID]: env.organizationId,
    [SemanticEnvResources.ORG_SLUG]: env.organization.slug,
    [SemanticEnvResources.ORG_TITLE]: env.organization.title,
    [SemanticEnvResources.PROJECT_ID]: env.projectId,
    [SemanticEnvResources.PROJECT_NAME]: env.project.name,
    [SemanticEnvResources.USER_ID]: env.orgMember?.userId,
  };
}

function parseInternalTraceHeaders(): Record<string, string> | undefined {
  try {
    return env.INTERNAL_OTEL_TRACE_EXPORTER_AUTH_HEADERS
      ? (JSON.parse(env.INTERNAL_OTEL_TRACE_EXPORTER_AUTH_HEADERS) as Record<string, string>)
      : undefined;
  } catch {
    return;
  }
}
