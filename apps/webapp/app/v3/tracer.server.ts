import { Attributes, DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { singleton } from "~/utils/singleton";

export const tracer = singleton("tracer", getTracer);

function getTracer() {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const provider = new NodeTracerProvider({
    forceFlushTimeoutMillis: 500,
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: "trigger.dev",
    }),
  });

  if (env.OTLP_EXPORTER_TRACES_URL) {
    const exporter = new OTLPTraceExporter({
      url: env.OTLP_EXPORTER_TRACES_URL,
      timeoutMillis: 1000,
    });

    provider.addSpanProcessor(new BatchSpanProcessor(exporter));

    console.log(`⚡ Tracer: OTLP exporter enabled to ${env.OTLP_EXPORTER_TRACES_URL}`);
  } else {
    const consoleExporter = new ConsoleSpanExporter();

    provider.addSpanProcessor(new SimpleSpanProcessor(consoleExporter));
  }

  provider.register();

  return provider.getTracer("trigger.dev", "3.0.0.dp.1");
}

export function attributesFromAuthenticatedEnv(env: AuthenticatedEnvironment): Attributes {
  return {
    environmentId: env.id,
    environmentType: env.type,
    environmentSlug: env.slug,
    organizationId: env.organizationId,
    organizationSlug: env.organization.slug,
    organizationTitle: env.organization.title,
    projectId: env.projectId,
    projectName: env.project.name,
    userId: env.orgMember?.userId,
  };
}
