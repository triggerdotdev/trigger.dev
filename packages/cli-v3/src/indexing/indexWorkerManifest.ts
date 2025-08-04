import { execPathForRuntime } from "@trigger.dev/core/v3/build";
import {
  TaskIndexingImportError,
  TaskMetadataParseError,
  UncaughtExceptionError,
} from "@trigger.dev/core/v3/errors";
import {
  BuildRuntime,
  indexerToWorkerMessages,
  WorkerManifest,
} from "@trigger.dev/core/v3/schemas";
import { parseMessageFromCatalog } from "@trigger.dev/core/v3/zodMessageHandler";
import { fork } from "node:child_process";

export type IndexWorkerManifestOptions = {
  runtime: BuildRuntime;
  indexWorkerPath: string;
  buildManifestPath: string;
  nodeOptions?: string;
  env: Record<string, string | undefined>;
  cwd?: string;
  otelHookInclude?: string[];
  otelHookExclude?: string[];
  handleStdout?: (data: string) => void;
  handleStderr?: (data: string) => void;
};

export async function indexWorkerManifest({
  runtime,
  indexWorkerPath,
  buildManifestPath,
  nodeOptions,
  env: $env,
  cwd,
  otelHookInclude,
  otelHookExclude,
  handleStderr,
  handleStdout,
}: IndexWorkerManifestOptions) {
  return await new Promise<WorkerManifest>((resolve, reject) => {
    let resolved = false;

    const child = fork(indexWorkerPath, {
      stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
      cwd,
      env: {
        ...$env,
        OTEL_IMPORT_HOOK_INCLUDES: otelHookInclude?.join(","),
        OTEL_IMPORT_HOOK_EXCLUDES: otelHookExclude?.join(","),
        TRIGGER_BUILD_MANIFEST_PATH: buildManifestPath,
        NODE_OPTIONS: nodeOptions,
        TRIGGER_INDEXING: "1",
      },
      execPath: execPathForRuntime(runtime),
    });

    // Set a timeout to kill the child process if it doesn't respond
    const timeout = setTimeout(() => {
      if (resolved) {
        return;
      }

      resolved = true;
      child.kill("SIGKILL");
      reject(new Error("Worker timed out"));
    }, 20_000);

    child.on("message", async (msg: any) => {
      const message = parseMessageFromCatalog(msg, indexerToWorkerMessages);

      switch (message.type) {
        case "INDEX_COMPLETE": {
          clearTimeout(timeout);
          resolved = true;
          if (message.payload.importErrors.length > 0) {
            reject(
              new TaskIndexingImportError(message.payload.importErrors, message.payload.manifest)
            );
          } else {
            resolve(message.payload.manifest);
          }
          child.kill("SIGKILL");
          break;
        }
        case "TASKS_FAILED_TO_PARSE": {
          clearTimeout(timeout);
          resolved = true;
          reject(new TaskMetadataParseError(message.payload.zodIssues, message.payload.tasks));
          child.kill("SIGKILL");
          break;
        }
        case "UNCAUGHT_EXCEPTION": {
          clearTimeout(timeout);
          resolved = true;
          reject(new UncaughtExceptionError(message.payload.error, message.payload.origin));
          child.kill("SIGKILL");
          break;
        }
      }
    });

    child.on("exit", (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        resolved = true;
        reject(new Error(`Worker exited with code ${code}`));
      }
    });

    child.stdout?.on("data", (data) => {
      handleStdout?.(data.toString());
    });

    child.stderr?.on("data", (data) => {
      handleStderr?.(data.toString());
    });
  });
}
