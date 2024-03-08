import { Resource } from "@opentelemetry/resources";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";
import {
  SemanticInternalAttributes,
  TracingDiagnosticLogLevel,
  TracingSDK,
} from "@trigger.dev/core/v3";

export const tracingSDK = new TracingSDK({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
  resource: new Resource({
    [SemanticInternalAttributes.CLI_VERSION]: "3.0.0",
  }),
  instrumentations: [new OpenAIInstrumentation()],
  diagLogLevel: (process.env.OTEL_LOG_LEVEL as TracingDiagnosticLogLevel) ?? "none",
});
