import { Resource } from "@opentelemetry/resources";
import {
  ProjectConfig,
  SemanticInternalAttributes,
  StandardTaskCatalog,
  TracingDiagnosticLogLevel,
  TracingSDK,
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

process.on("uncaughtException", (error, origin) => {
  process.send?.({
    type: "EVENT",
    message: {
      type: "UNCAUGHT_EXCEPTION",
      payload: {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
        origin,
      },
      version: "v1",
    },
  });
});

taskCatalog.setGlobalTaskCatalog(new StandardTaskCatalog());
