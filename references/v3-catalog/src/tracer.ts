import api, { DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { Resource } from "@opentelemetry/resources";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  ConsoleLogRecordExporter,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";

api.diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ALL);

const provider = new NodeTracerProvider({
  forceFlushTimeoutMillis: 500,
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: "@references/v3-catalog",
  }),
});

const exporter = new OTLPTraceExporter({
  url: "http://0.0.0.0:4318/v1/traces",
  timeoutMillis: 1000,
});

provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

registerInstrumentations({
  instrumentations: [],
});

const logExporter = new OTLPLogExporter({
  url: "http://0.0.0.0:4318/v1/logs",
});

// To start a logger, you first need to initialize the Logger provider.
const loggerProvider = new LoggerProvider();
// Add a processor to export log record
loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(new ConsoleLogRecordExporter()));
loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(logExporter));

//  To create a log record, you first need to get a Logger instance
export const logger = loggerProvider.getLogger("default");

export const getTracer = provider.getTracer.bind(provider);

export async function flushOtel() {
  await exporter.forceFlush();
  await loggerProvider.forceFlush();
}
