import { ExponentialBackoff } from "@trigger.dev/core-apps/backoff";
import { isExecaChildProcess, testDockerCheckpoint } from "@trigger.dev/core-apps/checkpoints";
import { SimpleLogger } from "@trigger.dev/core-apps/logger";
import { $ } from "execa";
import { nanoid } from "nanoid";
import fs from "node:fs/promises";
import { ChaosMonkey } from "./chaosMonkey";

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

  #logger = new SimpleLogger("[checkptr]");
  #abortControllers = new Map<string, AbortController>();
  #failedCheckpoints = new Map<string, unknown>();
  #waitingForRetry = new Set<string>();

  private registryHost: string;
  private registryNamespace: string;
  private registryTlsVerify: boolean;

  private disableCheckpointSupport: boolean;
  private checkpointPath: string;

  private simulateCheckpointFailure: boolean;
  private simulateCheckpointFailureSeconds: number;
  private simulatePushFailure: boolean;
  private simulatePushFailureSeconds: number;

  private chaosMonkey: ChaosMonkey;

  constructor(private opts: CheckpointerOptions) {
    this.#dockerMode = opts.dockerMode;

    this.registryHost = opts.registryHost ?? "localhost:5000";
    this.registryNamespace = opts.registryNamespace ?? "trigger";
    this.registryTlsVerify = opts.registryTlsVerify ?? true;

    this.disableCheckpointSupport = opts.disableCheckpointSupport ?? false;
    this.checkpointPath = opts.checkpointPath ?? "/checkpoints";

    this.simulateCheckpointFailure = opts.simulateCheckpointFailure ?? false;
    this.simulateCheckpointFailureSeconds = opts.simulateCheckpointFailureSeconds ?? 300;
    this.simulatePushFailure = opts.simulatePushFailure ?? false;
    this.simulatePushFailureSeconds = opts.simulatePushFailureSeconds ?? 300;

    this.chaosMonkey = opts.chaosMonkey ?? new ChaosMonkey(!!process.env.CHAOS_MONKEY_ENABLED);
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

      this.#logger.error(testCheckpoint.message, testCheckpoint.error ?? "");
      return this.#getInitReturn(false);
    } else {
      try {
        await $`buildah login --get-login ${this.registryHost}`;
      } catch (error) {
        this.#logger.error(`No checkpoint support: Not logged in to registry ${this.registryHost}`);
        return this.#getInitReturn(false);
      }
    }

    return this.#getInitReturn(true);
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
      return `${this.checkpointPath}/${basename}.tar`;
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

    controller.abort("cancelCheckpointing()");
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
          await new Promise((resolve) => setTimeout(resolve, delay.milliseconds));

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

    const $$ = $({ signal: controller.signal });

    const shortCode = nanoid(8);
    const imageRef = this.#getImageRef(projectRef, deploymentVersion, shortCode);
    const exportLocation = this.#getExportLocation(projectRef, deploymentVersion, shortCode);

    const cleanup = async () => {
      if (this.#dockerMode) {
        return;
      }

      try {
        await $`rm ${exportLocation}`;
        this.#logger.log("Deleted checkpoint archive", { exportLocation });

        await $`buildah rmi ${imageRef}`;
        this.#logger.log("Deleted checkpoint image", { imageRef });
      } catch (error) {
        this.#logger.error("Failure during checkpoint cleanup", { exportLocation, error });
      }
    };

    try {
      await this.chaosMonkey.call({ $: $$ });

      this.#logger.log("Checkpointing:", { options });

      const containterName = this.#getRunContainerName(runId, attemptNumber);

      // Create checkpoint (docker)
      if (this.#dockerMode) {
        try {
          if (this.opts.forceSimulate || !this.#canCheckpoint) {
            this.#logger.log("Simulating checkpoint");
            this.#logger.debug(await $$`docker pause ${containterName}`);
          } else {
            if (this.simulateCheckpointFailure) {
              if (performance.now() < this.simulateCheckpointFailureSeconds * 1000) {
                this.#logger.error("Simulating checkpoint failure", { options });
                throw new Error("SIMULATE_CHECKPOINT_FAILURE");
              }
            }

            if (leaveRunning) {
              this.#logger.debug(
                await $$`docker checkpoint create --leave-running ${containterName} ${exportLocation}`
              );
            } else {
              this.#logger.debug(
                await $$`docker checkpoint create ${containterName} ${exportLocation}`
              );
            }
          }
        } catch (error) {
          this.#logger.error("Failed while creating docker checkpoint", { exportLocation });
          throw error;
        }

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

      const containerId = this.#logger.debug(
        // @ts-expect-error
        await $$`crictl ps`
          .pipeStdout($$({ stdin: "pipe" })`grep ${containterName}`)
          .pipeStdout($$({ stdin: "pipe" })`cut -f1 ${"-d "}`)
      );

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
      this.#logger.debug(await $$`crictl checkpoint --export=${exportLocation} ${containerId}`);
      const postCheckpoint = performance.now();

      // Print checkpoint size
      const size = await getParsedFileSize(exportLocation);
      this.#logger.log("checkpoint archive created", { size, options });

      // Create image from checkpoint
      const container = this.#logger.debug(await $$`buildah from scratch`);
      const postFrom = performance.now();

      this.#logger.debug(await $$`buildah add ${container} ${exportLocation} /`);
      const postAdd = performance.now();

      this.#logger.debug(
        await $$`buildah config --annotation=io.kubernetes.cri-o.annotations.checkpoint.name=counter ${container}`
      );
      const postConfig = performance.now();

      this.#logger.debug(await $$`buildah commit ${container} ${imageRef}`);
      const postCommit = performance.now();

      this.#logger.debug(await $$`buildah rm ${container}`);
      const postRm = performance.now();

      if (this.simulatePushFailure) {
        if (performance.now() < this.simulatePushFailureSeconds * 1000) {
          this.#logger.error("Simulating push failure", { options });
          throw new Error("SIMULATE_PUSH_FAILURE");
        }
      }

      // Push checkpoint image
      this.#logger.debug(
        await $$`buildah push --tls-verify=${String(this.registryTlsVerify)} ${imageRef}`
      );
      const postPush = performance.now();

      const perf = {
        "crictl checkpoint": postCheckpoint - start,
        "buildah from": postFrom - postCheckpoint,
        "buildah add": postAdd - postFrom,
        "buildah config": postConfig - postAdd,
        "buildah commit": postCommit - postConfig,
        "buildah rm": postRm - postCommit,
        "buildah push": postPush - postRm,
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
      if (isExecaChildProcess(error)) {
        if (error.isCanceled) {
          this.#logger.error("Checkpoint canceled", { options, error });

          return { success: false, reason: "CANCELED" };
        }

        this.#logger.error("Checkpoint command error", { options, error });

        return { success: false, reason: "ERROR" };
      }

      this.#logger.error("Unhandled checkpoint error", { options, error });

      return { success: false, reason: "ERROR" };
    } finally {
      this.#abortControllers.delete(runId);
      await cleanup();
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
}
