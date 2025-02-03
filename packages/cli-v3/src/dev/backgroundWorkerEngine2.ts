import { BuildManifest, ServerBackgroundWorker, WorkerManifest } from "@trigger.dev/core/v3";
import { execOptionsForRuntime } from "@trigger.dev/core/v3/build";
import { Evt } from "evt";
import { join } from "node:path";
import { indexWorkerManifest } from "../indexing/indexWorkerManifest.js";
import { prettyError } from "../utilities/cliOutput.js";
import { writeJSONFile } from "../utilities/fileSystem.js";
import { logger } from "../utilities/logger.js";

export type BackgroundWorkerEngine2Options = {
  env: Record<string, string>;
  cwd: string;
  stop: () => void;
};

export class BackgroundWorkerEngine2 {
  public onTaskRunHeartbeat: Evt<string> = new Evt();

  public deprecated: boolean = false;
  public manifest: WorkerManifest | undefined;
  public serverWorker: ServerBackgroundWorker | undefined;

  constructor(
    public build: BuildManifest,
    public params: BackgroundWorkerEngine2Options
  ) {}

  deprecate() {
    if (this.deprecated) {
      return;
    }

    this.deprecated = true;

    this.#tryStopWorker();
  }

  #tryStopWorker() {
    if (this.deprecated) {
      logger.debug("Worker deprecated, stopping", { outputPath: this.build.outputPath });
      this.params.stop();
    }
  }

  get workerManifestPath(): string {
    return join(this.build.outputPath, "index.json");
  }

  get buildManifestPath(): string {
    return join(this.build.outputPath, "build.json");
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
        if (!data.includes("Debugger attached")) {
          prettyError(data.toString());
        }
      },
    });

    // Write the build manifest to this.build.outputPath/worker.json
    await writeJSONFile(this.workerManifestPath, this.manifest, true);

    logger.debug("worker manifest indexed", { path: this.build.outputPath });
  }
}
