import type { TriggerConfig } from "@trigger.dev/sdk/v3";
import {
  StandardTaskCatalog,
  type TracingDiagnosticLogLevel,
  TracingSDK,
  ZodMessageSender,
  childToWorkerMessages,
  taskCatalog,
  type OtelTracer,
  type OtelLogger,
} from "@trigger.dev/sdk/v3/unstable-core-do-not-import";

import * as importedConfig from "./trigger.config.js";

export const tracingSDK = new TracingSDK({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
  instrumentations: importedConfig.config?.instrumentations ?? [],
  diagLogLevel: (process.env.OTEL_LOG_LEVEL as TracingDiagnosticLogLevel) ?? "none",
});

export const otelTracer: OtelTracer = tracingSDK.getTracer("trigger-dev-worker", "v3.1.0-beta.0");
export const otelLogger: OtelLogger = tracingSDK.getLogger("trigger-dev-worker", "v3.1.0-beta.0");

export const sender = new ZodMessageSender({
  schema: childToWorkerMessages,
  sender: async (message) => {
    process.send?.(message);
  },
});

taskCatalog.setGlobalTaskCatalog(new StandardTaskCatalog());

import * as openai from "./trigger/openai.js";

type TaskFileImport = Record<string, unknown>;
const TaskFileImports: Record<string, TaskFileImport> = {};
const TaskFiles: Record<
  string,
  { triggerDir: string; importPath: string; importName: string; filePath: string }
> = {};

TaskFileImports["openai"] = openai;
TaskFiles["openai"] = {
  triggerDir: "/Users/eric/code/triggerdotdev/trigger.dev/references/v3-experiment/src/trigger",
  importPath: "src/trigger/openai.ts",
  importName: "openai",
  filePath: "src/trigger/openai.ts",
};

console.log(openai);
console.log(importedConfig.config);
