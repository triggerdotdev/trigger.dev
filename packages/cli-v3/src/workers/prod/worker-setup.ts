import { Resource } from "@opentelemetry/resources";
import { ProjectConfig, SemanticInternalAttributes, taskCatalog } from "@trigger.dev/core/v3";
import {
  TracingDiagnosticLogLevel,
  TracingSDK,
  StandardTaskCatalog,
} from "@trigger.dev/core/v3/workers";

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

taskCatalog.setGlobalTaskCatalog(new StandardTaskCatalog());
