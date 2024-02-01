import { TracerProvider } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { Resource } from "@opentelemetry/resources";
import {
  ConsoleLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";

declare const SERVICE_NAME: string;

const provider = new NodeTracerProvider({
  forceFlushTimeoutMillis: 500,
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
  }),
});

const exporter = new OTLPTraceExporter({
  url: "http://0.0.0.0:4318/v1/traces",
  timeoutMillis: 1000,
});

// provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

registerInstrumentations({
  instrumentations: [new FetchInstrumentation()],
});

const logExporter = new OTLPLogExporter({
  url: "http://0.0.0.0:4318/v1/logs",
});

// To start a logger, you first need to initialize the Logger provider.
const loggerProvider = new LoggerProvider();
// Add a processor to export log record
// loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(new ConsoleLogRecordExporter()));
loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(logExporter));

//  To create a log record, you first need to get a Logger instance
export const getLogger: LoggerProvider["getLogger"] = loggerProvider.getLogger.bind(loggerProvider);
export const getTracer: TracerProvider["getTracer"] = provider.getTracer.bind(provider);

export async function flushOtel() {
  await exporter.forceFlush();
  await loggerProvider.forceFlush();
}
