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
    const loggerExporter = new LoggerSpanExporter();

    provider.addSpanProcessor(new SimpleSpanProcessor(loggerExporter));
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

const SemanticAuthAttributes = {
  ENV_ID: "auth.env.id",
  ENV_TYPE: "auth.env.type",
  ENV_SLUG: "auth.env.slug",
  ORG_ID: "auth.org.id",
  ORG_SLUG: "auth.org.slug",
  ORG_TITLE: "auth.org.title",
  PROJECT_ID: "auth.project.id",
  PROJECT_NAME: "auth.project.name",
  USER_ID: "auth.user.id",
};

export function attributesFromAuthenticatedEnv(env: AuthenticatedEnvironment): Attributes {
  return {
    [SemanticAuthAttributes.ENV_ID]: env.id,
    [SemanticAuthAttributes.ENV_TYPE]: env.type,
    [SemanticAuthAttributes.ENV_SLUG]: env.slug,
    [SemanticAuthAttributes.ORG_ID]: env.organizationId,
    [SemanticAuthAttributes.ORG_SLUG]: env.organization.slug,
    [SemanticAuthAttributes.ORG_TITLE]: env.organization.title,
    [SemanticAuthAttributes.PROJECT_ID]: env.projectId,
    [SemanticAuthAttributes.PROJECT_NAME]: env.project.name,
    [SemanticAuthAttributes.USER_ID]: env.orgMember?.userId,
  };
}
