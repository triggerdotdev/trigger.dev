import "source-map-support/register.js";
import { Resource } from "@opentelemetry/resources";
import {
  ProjectConfig,
  SemanticInternalAttributes,
  StandardTaskCatalog,
  TracingDiagnosticLogLevel,
  TracingSDK,
  ZodMessageSender,
  childToWorkerMessages,
  taskCatalog,
} from "@trigger.dev/core/v3";

__SETUP_IMPORTED_PROJECT_CONFIG__;
declare const __SETUP_IMPORTED_PROJECT_CONFIG__: unknown;
declare const setupImportedConfig: ProjectConfig | undefined;

export const tracingSDK = new TracingSDK({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
  resource: new Resource({
    [SemanticInternalAttributes.CLI_VERSION]: "3.0.0",
  }),
  instrumentations: setupImportedConfig?.instrumentations ?? [],
  diagLogLevel: (process.env.OTEL_LOG_LEVEL as TracingDiagnosticLogLevel) ?? "none",
});

export const sender = new ZodMessageSender({
  schema: childToWorkerMessages,
  sender: async (message) => {
    process.send?.(message);
  },
});

process.on("uncaughtException", (error, origin) => {
  sender
    .send("UNCAUGHT_EXCEPTION", {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      origin,
    })
    .catch((err) => {
      console.error("Failed to send UNCAUGHT_EXCEPTION message", err);
    });
});

taskCatalog.setGlobalTaskCatalog(new StandardTaskCatalog());
