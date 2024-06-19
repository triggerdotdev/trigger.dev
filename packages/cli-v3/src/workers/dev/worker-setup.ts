import type { Tracer } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import { ProjectConfig, childToWorkerMessages, taskCatalog } from "@trigger.dev/core/v3";
import {
  StandardTaskCatalog,
  TracingDiagnosticLogLevel,
  TracingSDK,
} from "@trigger.dev/core/v3/workers";
import { ZodMessageSender } from "@trigger.dev/core/v3/zodMessageHandler";
import "source-map-support/register.js";
import * as packageJson from "../../../package.json";

__SETUP_IMPORTED_PROJECT_CONFIG__;
declare const __SETUP_IMPORTED_PROJECT_CONFIG__: unknown;
declare const setupImportedConfig: ProjectConfig | undefined;

export const tracingSDK = new TracingSDK({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
  instrumentations: setupImportedConfig?.instrumentations ?? [],
  diagLogLevel: (process.env.OTEL_LOG_LEVEL as TracingDiagnosticLogLevel) ?? "none",
  forceFlushTimeoutMillis: 5_000,
});

export const otelTracer: Tracer = tracingSDK.getTracer("trigger-dev-worker", packageJson.version);
export const otelLogger: Logger = tracingSDK.getLogger("trigger-dev-worker", packageJson.version);

export const sender = new ZodMessageSender({
  schema: childToWorkerMessages,
  sender: async (message) => {
    process.send?.(message);
  },
});

taskCatalog.setGlobalTaskCatalog(new StandardTaskCatalog());
