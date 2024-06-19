import type { Tracer } from "@opentelemetry/api";
import * as packageJson from "../../../package.json";
import { ProjectConfig, taskCatalog } from "@trigger.dev/core/v3";
import {
  TracingDiagnosticLogLevel,
  TracingSDK,
  StandardTaskCatalog,
} from "@trigger.dev/core/v3/workers";
import type { Logger } from "@opentelemetry/api-logs";

__SETUP_IMPORTED_PROJECT_CONFIG__;
declare const __SETUP_IMPORTED_PROJECT_CONFIG__: unknown;
declare const setupImportedConfig: ProjectConfig | undefined;

export const tracingSDK = new TracingSDK({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
  instrumentations: setupImportedConfig?.instrumentations ?? [],
  diagLogLevel: (process.env.OTEL_LOG_LEVEL as TracingDiagnosticLogLevel) ?? "none",
  forceFlushTimeoutMillis: process.env.OTEL_FORCE_FLUSH_TIMEOUT
    ? parseInt(process.env.OTEL_FORCE_FLUSH_TIMEOUT, 10)
    : 1_000,
});

export const otelTracer: Tracer = tracingSDK.getTracer("trigger-prod-worker", packageJson.version);
export const otelLogger: Logger = tracingSDK.getLogger("trigger-prod-worker", packageJson.version);

taskCatalog.setGlobalTaskCatalog(new StandardTaskCatalog());
