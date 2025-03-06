import { ExponentialBackoff } from "@trigger.dev/core/v3/apps";
import { testDockerCheckpoint } from "@trigger.dev/core/v3/serverOnly";
import { nanoid } from "nanoid";
import fs from "node:fs/promises";
import { ChaosMonkey } from "./chaosMonkey";
import { Buildah, Crictl, Exec } from "./exec";
import { setTimeout } from "node:timers/promises";
import { TempFileCleaner } from "./cleaner";
import { numFromEnv, boolFromEnv } from "./util";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";

type CheckpointerInitializeReturn = {
  canCheckpoint: boolean;
  willSimulate: boolean;
};

type CheckpointAndPushOptions = {
  runId: string;
  leaveRunning?: boolean;
  projectRef: string;
  deploymentVersion: string;
  shouldHeartbeat?: boolean;
  attemptNumber?: number;
};

type CheckpointAndPushResult =
  | { success: true; checkpoint: CheckpointData }
  | {
      success: false;
      reason?: "CANCELED" | "ERROR" | "SKIP_RETRYING";
    };

type CheckpointData = {
  location: string;
  docker: boolean;
};

type CheckpointerOptions = {
  dockerMode: boolean;
  forceSimulate: boolean;
  heartbeat: (runId: string) => void;
  registryHost?: string;
  registryNamespace?: string;
  registryTlsVerify?: boolean;
  disableCheckpointSupport?: boolean;
  checkpointPath?: string;
  simulateCheckpointFailure?: boolean;
  simulateCheckpointFailureSeconds?: number;
  simulatePushFailure?: boolean;
  simulatePushFailureSeconds?: number;
  chaosMonkey?: ChaosMonkey;
};

async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch (error) {
    console.error("Error getting file size:", error);
    return -1;
  }
}

async function getParsedFileSize(filePath: string) {
  const sizeInBytes = await getFileSize(filePath);

  let message = `Size in bytes: ${sizeInBytes}`;

  if (sizeInBytes > 1024 * 1024) {
    const sizeInMB = (sizeInBytes / 1024 / 1024).toFixed(2);
    message = `Size in MB (rounded): ${sizeInMB}`;
  } else if (sizeInBytes > 1024) {
    const sizeInKB = (sizeInBytes / 1024).toFixed(2);
    message = `Size in KB (rounded): ${sizeInKB}`;
  }

  return {
    path: filePath,
    sizeInBytes,
    message,
  };
}

export class Checkpointer {
  #initialized = false;
  #canCheckpoint = false;
  #dockerMode: boolean;

  #logger = new SimpleStructuredLogger("checkpointer");

  #failedCheckpoints = new Map<string, unknown>();

  // Indexed by run ID
  #runAbortControllers = new Map<
    string,
    { signal: AbortSignal; abort: AbortController["abort"] }
  >();

  private registryHost: string;
  private registryNamespace: string;
  private registryTlsVerify: boolean;

  private disableCheckpointSupport: boolean;

  private simulateCheckpointFailure: boolean;
  private simulateCheckpointFailureSeconds: number;
  private simulatePushFailure: boolean;
  private simulatePushFailureSeconds: number;

  private chaosMonkey: ChaosMonkey;
  private tmpCleaner?: TempFileCleaner;

  constructor(private opts: CheckpointerOptions) {
    this.#dockerMode = opts.dockerMode;

    this.registryHost = opts.registryHost ?? "localhost:5000";
    this.registryNamespace = opts.registryNamespace ?? "trigger";
    this.registryTlsVerify = opts.registryTlsVerify ?? true;

    this.disableCheckpointSupport = opts.disableCheckpointSupport ?? false;

    this.simulateCheckpointFailure = opts.simulateCheckpointFailure ?? false;
    this.simulateCheckpointFailureSeconds = opts.simulateCheckpointFailureSeconds ?? 300;
    this.simulatePushFailure = opts.simulatePushFailure ?? false;
    this.simulatePushFailureSeconds = opts.simulatePushFailureSeconds ?? 300;

    this.chaosMonkey = opts.chaosMonkey ?? new ChaosMonkey(!!process.env.CHAOS_MONKEY_ENABLED);
    this.tmpCleaner = this.#createTmpCleaner();
  }

  async init(): Promise<CheckpointerInitializeReturn> {
    if (this.#initialized) {
      return this.#getInitReturn(this.#canCheckpoint);
    }

    this.#logger.log(`${this.#dockerMode ? "Docker" : "Kubernetes"} mode`);

    if (this.#dockerMode) {
      const testCheckpoint = await testDockerCheckpoint();

      if (testCheckpoint.ok) {
        return this.#getInitReturn(true);
      }

      this.#logger.error(testCheckpoint.message, { error: testCheckpoint.error });
      return this.#getInitReturn(false);
    }

    const canLogin = await Buildah.canLogin(this.registryHost);

    if (!canLogin) {
      this.#logger.error(`No checkpoint support: Not logged in to registry ${this.registryHost}`);
    }

    return this.#getInitReturn(canLogin);
  }

  #getInitReturn(canCheckpoint: boolean): CheckpointerInitializeReturn {
    this.#canCheckpoint = canCheckpoint;

    if (canCheckpoint) {
      if (!this.#initialized) {
        this.#logger.log("Full checkpoint support!");
      }
    }

    this.#initialized = true;

    const willSimulate = this.#dockerMode && (!this.#canCheckpoint || this.opts.forceSimulate);

    if (willSimulate) {
      this.#logger.log("Simulation mode enabled. Containers will be paused, not checkpointed.", {
        forceSimulate: this.opts.forceSimulate,
      });
    }

    return {
      canCheckpoint,
      willSimulate,
    };
  }

  #getImageRef(projectRef: string, deploymentVersion: string, shortCode: string) {
    return `${this.registryHost}/${this.registryNamespace}/${projectRef}:${deploymentVersion}.prod-${shortCode}`;
  }

  #getExportLocation(projectRef: string, deploymentVersion: string, shortCode: string) {
    const basename = `${projectRef}-${deploymentVersion}-${shortCode}`;

    if (this.#dockerMode) {
      return basename;
    } else {
      return Crictl.getExportLocation(basename);
    }
  }

  async checkpointAndPush(
    opts: CheckpointAndPushOptions,
    delayMs?: number
  ): Promise<CheckpointData | undefined> {
    const start = performance.now();
    this.#logger.log(`checkpointAndPush() start`, { start, opts });

    const { runId } = opts;

    let interval: NodeJS.Timer | undefined;
    if (opts.shouldHeartbeat) {
      interval = setInterval(() => {
        this.#logger.log("Sending heartbeat", { runId });
        this.opts.heartbeat(runId);
      }, 20_000);
    }

    const controller = new AbortController();
    const signal = controller.signal;
    const abort = controller.abort.bind(controller);

    const onAbort = () => {
      this.#logger.error("Checkpoint aborted", { runId, options: opts });
    };

    signal.addEventListener("abort", onAbort, { once: true });

    const removeCurrentAbortController = () => {
      const controller = this.#runAbortControllers.get(runId);

      // Ensure only the current controller is removed
      if (controller && controller.signal === signal) {
        this.#runAbortControllers.delete(runId);
      }

      // Remove the abort listener in case it hasn't fired
      signal.removeEventListener("abort", onAbort);
    };

    if (!this.#dockerMode && !this.#canCheckpoint) {
      this.#logger.error("No checkpoint support. Simulation requires docker.");
      this.#failCheckpoint(runId, "NO_SUPPORT");
      return;
    }

    if (this.#isRunCheckpointing(runId)) {
      this.#logger.error("Checkpoint procedure already in progress", { options: opts });
      this.#failCheckpoint(runId, "IN_PROGRESS");
      return;
    }

    // This is a new checkpoint, clear any last failure for this run
    this.#clearFailedCheckpoint(runId);

    if (this.disableCheckpointSupport) {
      this.#logger.error("Checkpoint support disabled", { options: opts });
      this.#failCheckpoint(runId, "DISABLED");
      return;
    }

    this.#runAbortControllers.set(runId, { signal, abort });

    try {
      const result = await this.#checkpointAndPushWithBackoff(opts, { delayMs, signal });

      const end = performance.now();
      this.#logger.log(`checkpointAndPush() end`, {
        start,
        end,
        diff: end - start,
        diffWithoutDelay: end - start - (delayMs ?? 0),
        opts,
        success: result.success,
        delayMs,
      });

      if (!result.success) {
        return;
      }

      return result.checkpoint;
    } finally {
      if (opts.shouldHeartbeat) {
        // @ts-ignore - Some kind of node incompatible type issue
        clearInterval(interval);
      }
      removeCurrentAbortController();
    }
  }

  #isRunCheckpointing(runId: string) {
    return this.#runAbortControllers.has(runId);
  }

  cancelAllCheckpointsForRun(runId: string): boolean {
    this.#logger.log("cancelAllCheckpointsForRun: call", { runId });

    // If the last checkpoint failed, pretend we canceled it
    // This ensures tasks don't wait for external resume messages to continue
    if (this.#hasFailedCheckpoint(runId)) {
      this.#logger.log("cancelAllCheckpointsForRun: hasFailedCheckpoint", { runId });
      this.#clearFailedCheckpoint(runId);
      return true;
    }

    const controller = this.#runAbortControllers.get(runId);

    if (!controller) {
      this.#logger.debug("cancelAllCheckpointsForRun: no abort controller", { runId });
      return false;
    }

    const { abort, signal } = controller;

    if (signal.aborted) {
      this.#logger.debug("cancelAllCheckpointsForRun: signal already aborted", { runId });
      return false;
    }

    abort("cancelCheckpoint()");
    this.#runAbortControllers.delete(runId);

    return true;
  }

  async #checkpointAndPushWithBackoff(
    {
      runId,
      leaveRunning = true, // This mirrors kubernetes behaviour more accurately
      projectRef,
      deploymentVersion,
      attemptNumber,
    }: CheckpointAndPushOptions,
    { delayMs, signal }: { delayMs?: number; signal: AbortSignal }
  ): Promise<CheckpointAndPushResult> {
    if (delayMs && delayMs > 0) {
      this.#logger.log("Delaying checkpoint", { runId, delayMs });

      try {
        await setTimeout(delayMs, undefined, { signal });
      } catch (error) {
        this.#logger.log("Checkpoint canceled during initial delay", { runId });
        return { success: false, reason: "CANCELED" };
      }
    }

    this.#logger.log("Checkpointing with backoff", {
      runId,
      leaveRunning,
      projectRef,
      deploymentVersion,
    });

    const backoff = new ExponentialBackoff()
      .type("EqualJitter")
      .base(3)
      .max(3 * 3600)
      .maxElapsed(48 * 3600);

    for await (const { delay, retry } of backoff) {
      try {
        if (retry > 0) {
          this.#logger.error("Retrying checkpoint", {
            runId,
            retry,
            delay,
          });

          try {
            await setTimeout(delay.milliseconds, undefined, { signal });
          } catch (error) {
            this.#logger.log("Checkpoint canceled during retry delay", { runId });
            return { success: false, reason: "CANCELED" };
          }
        }

        const result = await this.#checkpointAndPush(
          {
            runId,
            leaveRunning,
            projectRef,
            deploymentVersion,
            attemptNumber,
          },
          { signal }
        );

        if (result.success) {
          return result;
        }

        if (result.reason === "CANCELED") {
          this.#logger.log("Checkpoint canceled, won't retry", { runId });
          // Don't fail the checkpoint, as it was canceled
          return result;
        }

        if (result.reason === "SKIP_RETRYING") {
          this.#logger.log("Skipping retrying", { runId });
          return result;
        }

        continue;
      } catch (error) {
        this.#logger.error("Checkpoint error", {
          retry,
          runId,
          delay,
          error: error instanceof Error ? error.message : error,
        });
      }
    }

    this.#logger.error(`Checkpoint failed after exponential backoff`, {
      runId,
      leaveRunning,
      projectRef,
      deploymentVersion,
    });
    this.#failCheckpoint(runId, "ERROR");

    return { success: false, reason: "ERROR" };
  }

  async #checkpointAndPush(
    {
      runId,
      leaveRunning = true, // This mirrors kubernetes behaviour more accurately
      projectRef,
      deploymentVersion,
      attemptNumber,
    }: CheckpointAndPushOptions,
    { signal }: { signal: AbortSignal }
  ): Promise<CheckpointAndPushResult> {
    await this.init();

    const options = {
      runId,
      leaveRunning,
      projectRef,
      deploymentVersion,
      attemptNumber,
    };

    const shortCode = nanoid(8);
    const imageRef = this.#getImageRef(projectRef, deploymentVersion, shortCode);
    const exportLocation = this.#getExportLocation(projectRef, deploymentVersion, shortCode);

    const buildah = new Buildah({ id: `${runId}-${shortCode}`, abortSignal: signal });
    const crictl = new Crictl({ id: `${runId}-${shortCode}`, abortSignal: signal });

    const cleanup = async () => {
      const metadata = {
        runId,
        exportLocation,
        imageRef,
      };

      if (this.#dockerMode) {
        this.#logger.debug("Skipping cleanup in docker mode", metadata);
        return;
      }

      this.#logger.log("Cleaning up", metadata);

      try {
        await buildah.cleanup();
        await crictl.cleanup();
      } catch (error) {
        this.#logger.error("Error during cleanup", { ...metadata, error });
      }
    };

    try {
      await this.chaosMonkey.call();

      this.#logger.log("checkpointAndPush: checkpointing", { options });

      const containterName = this.#getRunContainerName(runId);

      // Create checkpoint (docker)
      if (this.#dockerMode) {
        await this.#createDockerCheckpoint(
          signal,
          runId,
          exportLocation,
          leaveRunning,
          attemptNumber
        );

        this.#logger.log("checkpointAndPush: checkpoint created", {
          runId,
          location: exportLocation,
        });

        return {
          success: true,
          checkpoint: {
            location: exportLocation,
            docker: true,
          },
        };
      }

      // Create checkpoint (CRI)
      if (!this.#canCheckpoint) {
        this.#logger.error("No checkpoint support in kubernetes mode.");
        return { success: false, reason: "SKIP_RETRYING" };
      }

      const containerId = await crictl.ps(containterName, true);

      if (!containerId.stdout) {
        this.#logger.error("could not find container id", { options, containterName });
        return { success: false, reason: "SKIP_RETRYING" };
      }

      const start = performance.now();

      if (this.simulateCheckpointFailure) {
        if (performance.now() < this.simulateCheckpointFailureSeconds * 1000) {
          this.#logger.error("Simulating checkpoint failure", { options });
          throw new Error("SIMULATE_CHECKPOINT_FAILURE");
        }
      }

      // Create checkpoint
      await crictl.checkpoint(containerId.stdout, exportLocation);
      const postCheckpoint = performance.now();

      // Print checkpoint size
      const size = await getParsedFileSize(exportLocation);
      this.#logger.log("checkpoint archive created", { size, options });

      // Create image from checkpoint
      const workingContainer = await buildah.from("scratch");
      const postFrom = performance.now();

      await buildah.add(workingContainer.stdout, exportLocation, "/");
      const postAdd = performance.now();

      await buildah.config(workingContainer.stdout, [
        `io.kubernetes.cri-o.annotations.checkpoint.name=${shortCode}`,
      ]);
      const postConfig = performance.now();

      await buildah.commit(workingContainer.stdout, imageRef);
      const postCommit = performance.now();

      if (this.simulatePushFailure) {
        if (performance.now() < this.simulatePushFailureSeconds * 1000) {
          this.#logger.error("Simulating push failure", { options });
          throw new Error("SIMULATE_PUSH_FAILURE");
        }
      }

      // Push checkpoint image
      await buildah.push(imageRef, this.registryTlsVerify);
      const postPush = performance.now();

      const perf = {
        "crictl checkpoint": postCheckpoint - start,
        "buildah from": postFrom - postCheckpoint,
        "buildah add": postAdd - postFrom,
        "buildah config": postConfig - postAdd,
        "buildah commit": postCommit - postConfig,
        "buildah push": postPush - postCommit,
      };

      this.#logger.log("Checkpointed and pushed image to:", { location: imageRef, perf });

      return {
        success: true,
        checkpoint: {
          location: imageRef,
          docker: false,
        },
      };
    } catch (error) {
      if (error instanceof Exec.Result) {
        if (error.aborted) {
          this.#logger.error("Checkpoint canceled: Exec", { options });

          return { success: false, reason: "CANCELED" };
        } else {
          this.#logger.error("Checkpoint command error", { options, error });

          return { success: false, reason: "ERROR" };
        }
      }

      this.#logger.error("Unhandled checkpoint error", {
        options,
        error: error instanceof Error ? error.message : error,
      });

      return { success: false, reason: "ERROR" };
    } finally {
      await cleanup();

      if (signal.aborted) {
        this.#logger.error("Checkpoint canceled: Cleanup", { options });

        // Overrides any prior return value
        return { success: false, reason: "CANCELED" };
      }
    }
  }

  async unpause(runId: string, attemptNumber?: number): Promise<void> {
    try {
      const containterNameWithAttempt = this.#getRunContainerName(runId, attemptNumber);
      const exec = new Exec({ logger: this.#logger });
      await exec.x("docker", ["unpause", containterNameWithAttempt]);
    } catch (error) {
      this.#logger.error("[Docker] Error during unpause", { runId, attemptNumber, error });
    }
  }

  async #createDockerCheckpoint(
    abortSignal: AbortSignal,
    runId: string,
    exportLocation: string,
    leaveRunning: boolean,
    attemptNumber?: number
  ) {
    const containterNameWithAttempt = this.#getRunContainerName(runId, attemptNumber);
    const exec = new Exec({ logger: this.#logger, abortSignal });

    try {
      if (this.opts.forceSimulate || !this.#canCheckpoint) {
        this.#logger.log("Simulating checkpoint");

        await exec.x("docker", ["pause", containterNameWithAttempt]);

        return;
      }

      if (this.simulateCheckpointFailure) {
        if (performance.now() < this.simulateCheckpointFailureSeconds * 1000) {
          this.#logger.error("Simulating checkpoint failure", {
            runId,
            exportLocation,
            leaveRunning,
            attemptNumber,
          });

          throw new Error("SIMULATE_CHECKPOINT_FAILURE");
        }
      }

      const args = ["checkpoint", "create"];

      if (leaveRunning) {
        args.push("--leave-running");
      }

      args.push(containterNameWithAttempt, exportLocation);

      await exec.x("docker", args);
    } catch (error) {
      this.#logger.error("Failed while creating docker checkpoint", { exportLocation });
      throw error;
    }
  }

  #failCheckpoint(runId: string, error: unknown) {
    this.#failedCheckpoints.set(runId, error);
  }

  #clearFailedCheckpoint(runId: string) {
    this.#failedCheckpoints.delete(runId);
  }

  #hasFailedCheckpoint(runId: string) {
    return this.#failedCheckpoints.has(runId);
  }

  #getRunContainerName(suffix: string, attemptNumber?: number) {
    return `task-run-${suffix}${attemptNumber && attemptNumber > 1 ? `-att${attemptNumber}` : ""}`;
  }

  #createTmpCleaner() {
    if (!boolFromEnv("TMP_CLEANER_ENABLED", false)) {
      return;
    }

    const defaultPaths = [Buildah.tmpDir, Crictl.checkpointDir].filter(Boolean);
    const pathsOverride = process.env.TMP_CLEANER_PATHS_OVERRIDE?.split(",").filter(Boolean) ?? [];
    const paths = pathsOverride.length ? pathsOverride : defaultPaths;

    if (paths.length === 0) {
      this.#logger.error("TempFileCleaner enabled but no paths to clean", {
        defaultPaths,
        pathsOverride,
        TMP_CLEANER_PATHS_OVERRIDE: process.env.TMP_CLEANER_PATHS_OVERRIDE,
      });

      return;
    }
    const cleaner = new TempFileCleaner({
      paths,
      maxAgeMinutes: numFromEnv("TMP_CLEANER_MAX_AGE_MINUTES", 60),
      intervalSeconds: numFromEnv("TMP_CLEANER_INTERVAL_SECONDS", 300),
      leadingEdge: boolFromEnv("TMP_CLEANER_LEADING_EDGE", false),
    });

    cleaner.start();

    return cleaner;
  }
}
