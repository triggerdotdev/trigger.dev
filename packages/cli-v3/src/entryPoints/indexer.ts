import {
  BuildManifest,
  type HandleErrorFunction,
  indexerToWorkerMessages,
  taskCatalog,
  TriggerConfig,
} from "@trigger.dev/core/v3";
import {
  StandardTaskCatalog,
  TracingDiagnosticLogLevel,
  TracingSDK,
} from "@trigger.dev/core/v3/workers";
import { sendMessageInCatalog, ZodSchemaParsedError } from "@trigger.dev/core/v3/zodMessageHandler";
import { readFile } from "node:fs/promises";
import sourceMapSupport from "source-map-support";

sourceMapSupport.install({
  handleUncaughtExceptions: false,
  environment: "node",
  hookRequire: false,
});

process.on("uncaughtException", function (error, origin) {
  if (error instanceof Error) {
    process.send &&
      process.send({
        type: "UNCAUGHT_EXCEPTION",
        payload: {
          error: { name: error.name, message: error.message, stack: error.stack },
          origin,
        },
        version: "v1",
      });
  } else {
    process.send &&
      process.send({
        type: "UNCAUGHT_EXCEPTION",
        payload: {
          error: {
            name: "Error",
            message: typeof error === "string" ? error : JSON.stringify(error),
          },
          origin,
        },
        version: "v1",
      });
  }
});

taskCatalog.setGlobalTaskCatalog(new StandardTaskCatalog());

async function importConfig(
  configPath: string
): Promise<{ config: TriggerConfig; handleError?: HandleErrorFunction }> {
  const configModule = await import(configPath);

  const config = configModule?.default ?? configModule?.config;

  return {
    config,
    handleError: configModule?.handleError,
  };
}

async function loadBuildManifest() {
  const manifestContents = await readFile(process.env.TRIGGER_BUILD_MANIFEST_PATH!, "utf-8");
  const raw = JSON.parse(manifestContents);

  return BuildManifest.parse(raw);
}

async function bootstrap() {
  const buildManifest = await loadBuildManifest();

  const { config } = await importConfig(buildManifest.configPath);

  // This needs to run or the PrismaInstrumentation will throw an error
  const tracingSDK = new TracingSDK({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
    instrumentations: config.instrumentations ?? [],
    diagLogLevel: (process.env.OTEL_LOG_LEVEL as TracingDiagnosticLogLevel) ?? "none",
    forceFlushTimeoutMillis: 30_000,
  });

  for (const file of buildManifest.files) {
    const module = await import(file.out);

    for (const exportName of getExportNames(module)) {
      const task = module[exportName] ?? module.default?.[exportName];

      if (!task) {
        continue;
      }

      if (task[Symbol.for("trigger.dev/task")]) {
        if (taskCatalog.taskExists(task.id)) {
          taskCatalog.registerTaskFileMetadata(task.id, {
            exportName,
            filePath: file.entry,
            entryPoint: file.out,
          });
        }
      }
    }
  }

  return {
    tracingSDK,
    config,
    buildManifest,
  };
}

const { buildManifest } = await bootstrap();

const tasks = taskCatalog.listTaskManifests();

await sendMessageInCatalog(
  indexerToWorkerMessages,
  "INDEX_COMPLETE",
  {
    manifest: {
      tasks,
      configPath: buildManifest.configPath,
    },
  },
  async (msg) => {
    process.send?.(msg);
  }
).catch((err) => {
  if (err instanceof ZodSchemaParsedError) {
    return sendMessageInCatalog(
      indexerToWorkerMessages,
      "TASKS_FAILED_TO_PARSE",
      { zodIssues: err.error.issues, tasks },
      async (msg) => {
        process.send?.(msg);
      }
    );
  } else {
    console.error("Failed to send TASKS_READY message", err);
  }

  return;
});

function getExportNames(module: any) {
  const exports: string[] = [];

  const exportKeys = Object.keys(module);

  if (exportKeys.length === 0) {
    return exports;
  }

  if (exportKeys.length === 1 && exportKeys[0] === "default") {
    return Object.keys(module.default);
  }

  return exportKeys;
}
