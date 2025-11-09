import { BuildManifest, ServerBackgroundWorker, WorkerManifest } from "@trigger.dev/core/v3";
import { execOptionsForRuntime } from "@trigger.dev/core/v3/build";
import { join } from "node:path";
import { indexWorkerManifest } from "../indexing/indexWorkerManifest.js";
import { prettyError } from "../utilities/cliOutput.js";
import { writeJSONFile } from "../utilities/fileSystem.js";
import { logger } from "../utilities/logger.js";
import type { Metafile } from "esbuild";

export type BackgroundWorkerOptions = {
  env: Record<string, string>;
  cwd: string;
  stop: () => void;
};

export class BackgroundWorker {
  public deprecated: boolean = false;
  public manifest: WorkerManifest | undefined;
  public serverWorker: ServerBackgroundWorker | undefined;

  constructor(
    public build: BuildManifest,
    public metafile: Metafile,
    public params: BackgroundWorkerOptions
  ) {}

  deprecate() {
    this.deprecated = true;
  }

  get workerManifestPath(): string {
    return join(this.build.outputPath, "index.json");
  }

  get buildManifestPath(): string {
    return join(this.build.outputPath, "build.json");
  }

  stop() {
    logger.debug("[BackgroundWorker] Stopping worker", {
      version: this.serverWorker?.version,
      outputPath: this.build.outputPath,
    });
    this.params.stop();
  }

  async initialize() {
    if (this.manifest) {
      throw new Error("Worker already initialized");
    }

    // Write the build manifest to this.build.outputPath/build.json
    await writeJSONFile(this.buildManifestPath, this.build, true);

    logger.debug("indexing worker manifest", { build: this.build, params: this.params });

    this.manifest = await indexWorkerManifest({
      runtime: this.build.runtime,
      indexWorkerPath: this.build.indexWorkerEntryPoint,
      buildManifestPath: this.buildManifestPath,
      nodeOptions: execOptionsForRuntime(this.build.runtime, this.build),
      env: this.params.env,
      cwd: this.params.cwd,
      otelHookInclude: this.build.otelImportHook?.include,
      otelHookExclude: this.build.otelImportHook?.exclude,
      handleStdout(data) {
        logger.debug(data);
      },
      handleStderr(data) {
        if (data.includes("Debugger attached")) {
          return;
        }

        // For Python workers, parse JSON logs and route based on level
        // Split by newlines since multiple logs can come in one chunk
        const lines = data.toString().split("\n");

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const log = JSON.parse(trimmed);
            // Validate log has required structured fields
            if (
              log &&
              typeof log === "object" &&
              typeof log.level === "string" &&
              typeof log.message === "string"
            ) {
              // Python structured logs - route based on level
              switch (log.level) {
                case "ERROR":
                  prettyError(trimmed);
                  break;
                case "WARN":
                case "WARNING":
                  logger.warn(log.message, log);
                  break;
                case "INFO":
                  logger.info(log.message, log);
                  break;
                case "DEBUG":
                  logger.debug(log.message, log);
                  break;
                default:
                  // Unknown level, treat as debug
                  logger.debug(trimmed);
              }
            } else {
              // Valid JSON but not a structured log, treat as error
              prettyError(trimmed);
            }
          } catch (error) {
            // Not valid JSON, treat as error
            prettyError(trimmed);
          }
        }
      },
    });

    // Write the build manifest to this.build.outputPath/worker.json
    await writeJSONFile(this.workerManifestPath, this.manifest, true);

    logger.debug("worker manifest indexed", { path: this.build.outputPath });
  }
}
