import { ExponentialBackoff } from "@trigger.dev/core/v3/apps";
import { testDockerCheckpoint } from "@trigger.dev/core/v3/apps";
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
      reason?: "CANCELED" | "DISABLED" | "ERROR" | "IN_PROGRESS" | "NO_SUPPORT" | "SKIP_RETRYING";
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
  #abortControllers = new Map<string, AbortController>();
  #failedCheckpoints = new Map<string, unknown>();
  #waitingForRetry = new Set<string>();

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

  async checkpointAndPush(opts: CheckpointAndPushOptions): Promise<CheckpointData | undefined> {
    const start = performance.now();
    this.#logger.log(`checkpointAndPush() start`, { start, opts });

    let interval: NodeJS.Timer | undefined;

    if (opts.shouldHeartbeat) {
      interval = setInterval(() => {
        this.#logger.log("Sending heartbeat", { runId: opts.runId });
        this.opts.heartbeat(opts.runId);
      }, 20_000);
    }

    try {
      const result = await this.#checkpointAndPushWithBackoff(opts);

      const end = performance.now();
      this.#logger.log(`checkpointAndPush() end`, {
        start,
        end,
        diff: end - start,
        opts,
        success: result.success,
      });

      if (!result.success) {
        return;
      }

      return result.checkpoint;
    } finally {
      if (opts.shouldHeartbeat) {
        clearInterval(interval);
      }
    }
  }

  isCheckpointing(runId: string) {
    return this.#abortControllers.has(runId) || this.#waitingForRetry.has(runId);
  }

  cancelCheckpoint(runId: string): boolean {
    // If the last checkpoint failed, pretend we canceled it
    // This ensures tasks don't wait for external resume messages to continue
    if (this.#hasFailedCheckpoint(runId)) {
      this.#clearFailedCheckpoint(runId);
      return true;
    }

    if (this.#waitingForRetry.has(runId)) {
      this.#waitingForRetry.delete(runId);
      return true;
    }

    const controller = this.#abortControllers.get(runId);

    if (!controller) {
      this.#logger.debug("Nothing to cancel", { runId });
      return false;
    }

    if (controller.signal.aborted) {
      this.#logger.debug("Controller already aborted", { runId });
      return false;
    }

    controller.abort("cancelCheckpoint()");
    this.#abortControllers.delete(runId);

    return true;
  }

  async #checkpointAndPushWithBackoff({
    runId,
    leaveRunning = true, // This mirrors kubernetes behaviour more accurately
    projectRef,
    deploymentVersion,
    attemptNumber,
  }: CheckpointAndPushOptions): Promise<CheckpointAndPushResult> {
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

          this.#waitingForRetry.add(runId);
          await setTimeout(delay.milliseconds);

          if (!this.#waitingForRetry.has(runId)) {
            this.#logger.log("Checkpoint canceled while waiting for retry", { runId });
            return { success: false, reason: "CANCELED" };
          } else {
            this.#waitingForRetry.delete(runId);
          }
        }

        const result = await this.#checkpointAndPush({
          runId,
          leaveRunning,
          projectRef,
          deploymentVersion,
          attemptNumber,
        });

        if (result.success) {
          return result;
        }

        if (result.reason === "CANCELED") {
          this.#logger.log("Checkpoint canceled, won't retry", { runId });
          // Don't fail the checkpoint, as it was canceled
          return result;
        }

        if (result.reason === "IN_PROGRESS") {
          this.#logger.log("Checkpoint already in progress, won't retry", { runId });
          this.#failCheckpoint(runId, result.reason);
          return result;
        }

        if (result.reason === "NO_SUPPORT") {
          this.#logger.log("No checkpoint support, won't retry", { runId });
          this.#failCheckpoint(runId, result.reason);
          return result;
        }

        if (result.reason === "DISABLED") {
          this.#logger.log("Checkpoint support disabled, won't retry", { runId });
          this.#failCheckpoint(runId, result.reason);
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

  async #checkpointAndPush({
    runId,
    leaveRunning = true, // This mirrors kubernetes behaviour more accurately
    projectRef,
    deploymentVersion,
    attemptNumber,
  }: CheckpointAndPushOptions): Promise<CheckpointAndPushResult> {
    await this.init();

    const options = {
      runId,
      leaveRunning,
      projectRef,
      deploymentVersion,
      attemptNumber,
    };

    if (!this.#dockerMode && !this.#canCheckpoint) {
      this.#logger.error("No checkpoint support. Simulation requires docker.");
      return { success: false, reason: "NO_SUPPORT" };
    }

    if (this.isCheckpointing(runId)) {
      this.#logger.error("Checkpoint procedure already in progress", { options });
      return { success: false, reason: "IN_PROGRESS" };
    }

    // This is a new checkpoint, clear any last failure for this run
    this.#clearFailedCheckpoint(runId);

    if (this.disableCheckpointSupport) {
      this.#logger.error("Checkpoint support disabled", { options });
      return { success: false, reason: "DISABLED" };
    }

    const controller = new AbortController();
    this.#abortControllers.set(runId, controller);

    const onAbort = () => {
      this.#logger.error("Checkpoint aborted", { options });
      controller.signal.removeEventListener("abort", onAbort);
    };
    controller.signal.addEventListener("abort", onAbort);

    const shortCode = nanoid(8);
    const imageRef = this.#getImageRef(projectRef, deploymentVersion, shortCode);
    const exportLocation = this.#getExportLocation(projectRef, deploymentVersion, shortCode);

    const buildah = new Buildah({ id: `${runId}-${shortCode}`, abortSignal: controller.signal });
    const crictl = new Crictl({ id: `${runId}-${shortCode}`, abortSignal: controller.signal });

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

      // Ensure only the current controller is removed
      if (this.#abortControllers.get(runId) === controller) {
        this.#abortControllers.delete(runId);
      }
      controller.signal.removeEventListener("abort", onAbort);
    };

    try {
      await this.chaosMonkey.call();

      this.#logger.log("Checkpointing:", { options });

      const containterName = this.#getRunContainerName(runId);

      // Create checkpoint (docker)
      if (this.#dockerMode) {
        await this.#createDockerCheckpoint(
          controller.signal,
          runId,
          exportLocation,
          leaveRunning,
          attemptNumber
        );

        this.#logger.log("checkpoint created:", {
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

      this.#logger.error("Unhandled checkpoint error", { options, error });

      return { success: false, reason: "ERROR" };
    } finally {
      await cleanup();

      if (controller.signal.aborted) {
        this.#logger.error("Checkpoint canceled: Cleanup", { options });

        // Overrides any prior return value
        return { success: false, reason: "CANCELED" };
      }
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
