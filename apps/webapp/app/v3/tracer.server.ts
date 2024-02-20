import {
  Attributes,
  Context,
  DiagConsoleLogger,
  DiagLogLevel,
  Link,
  SpanKind,
  diag,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
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
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { singleton } from "~/utils/singleton";
import { LoggerSpanExporter } from "./telemetry/loggerExporter.server";
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
    if (
      !parentContext &&
      ((attributes && attributes["model"] && attributes["method"]) || name.includes("prisma"))
    ) {
      return { decision: SamplingDecision.NOT_RECORD };
    }

    // For all other spans, defer to the base sampler
    return this._baseSampler.shouldSample(context, traceId, name, spanKind, attributes, links);
  }

  toString(): string {
    return `CustomWebappSampler`;
  }
}

export const tracer = singleton("tracer", getTracer);

function getTracer() {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const provider = new NodeTracerProvider({
    forceFlushTimeoutMillis: 500,
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: "trigger.dev",
    }),
    sampler: new ParentBasedSampler({
      root: new CustomWebappSampler(
        new TraceIdRatioBasedSampler(env.APP_ENV === "development" ? 1.0 : 0.05)
      ), // 5% sampling
    }), // 5% sampling
  });

  if (env.OTLP_EXPORTER_TRACES_URL) {
    const exporter = new OTLPTraceExporter({
      url: env.OTLP_EXPORTER_TRACES_URL,
      timeoutMillis: 1000,
    });

    provider.addSpanProcessor(new BatchSpanProcessor(exporter));

    console.log(`⚡ Tracer: OTLP exporter enabled to ${env.OTLP_EXPORTER_TRACES_URL}`);
  } else {
    if (env.LOG_TELEMETRY === "true") {
      const loggerExporter = new LoggerSpanExporter();

      provider.addSpanProcessor(new SimpleSpanProcessor(loggerExporter));
    }
  }

  provider.register();

  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new PrismaInstrumentation(),
    ],
  });

  return provider.getTracer("trigger.dev", "3.0.0.dp.1");
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
