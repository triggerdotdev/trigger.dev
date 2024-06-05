import { DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { InstrumentationOption, registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { Resource } from "@opentelemetry/resources";
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export const tracer = getTracer();

function getTracer() {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const provider = new NodeTracerProvider({
    forceFlushTimeoutMillis: 500,
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: "v3-catalog",
    }),
  });

  const loggerExporter = new ConsoleSpanExporter();
  provider.addSpanProcessor(new SimpleSpanProcessor(loggerExporter));

  provider.register();

  let instrumentations: InstrumentationOption[] = [
    new HttpInstrumentation(),
    new FetchInstrumentation(),
    new UndiciInstrumentation(),
  ];

  registerInstrumentations({
    tracerProvider: provider,
    instrumentations,
  });

  return provider.getTracer("v3-catalog", "3.0.0.dp.1");
}
