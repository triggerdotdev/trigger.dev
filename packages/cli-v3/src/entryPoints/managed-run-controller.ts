import { logger } from "../utilities/logger.js";
import { TaskRunProcess } from "../executions/taskRunProcess.js";
import { env as stdEnv } from "std-env";
import { readJSONFile } from "../utilities/fileSystem.js";
import {
  type CompleteRunAttemptResult,
  HeartbeatService,
  type RunExecutionData,
  SuspendedProcessError,
  type TaskRunExecutionMetrics,
  type TaskRunExecutionResult,
  type TaskRunFailedExecutionResult,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import {
  WarmStartClient,
  WORKLOAD_HEADERS,
  type WorkloadClientToServerEvents,
  type WorkloadDebugLogRequestBody,
  WorkloadHttpClient,
  type WorkloadServerToClientEvents,
  type WorkloadRunAttemptStartResponseBody,
} from "@trigger.dev/core/v3/workers";
import { assertExhaustive } from "../utilities/assertExhaustive.js";
import { setTimeout as sleep } from "timers/promises";
import { io, type Socket } from "socket.io-client";
import { RunnerEnv } from "./managed/env.js";
import { MetadataClient } from "./managed/overrides.js";

logger.loggerLevel = "debug";

const env = new RunnerEnv(stdEnv);

type ManagedRunControllerOptions = {
  workerManifest: WorkerManifest;
};

type Run = {
  friendlyId: string;
  attemptNumber?: number | null;
};

type Snapshot = {
  friendlyId: string;
};

class ManagedRunController {
  private taskRunProcess?: TaskRunProcess;

  private readonly workerManifest: WorkerManifest;

  private readonly httpClient: WorkloadHttpClient;
  private readonly warmStartClient: WarmStartClient | undefined;
  private readonly metadataClient?: MetadataClient;

  private socket: Socket<WorkloadServerToClientEvents, WorkloadClientToServerEvents>;

  private readonly runHeartbeat: HeartbeatService;
  private readonly snapshotPoller: HeartbeatService;

  get heartbeatIntervalSeconds() {
    return env.TRIGGER_HEARTBEAT_INTERVAL_SECONDS;
  }

  get snapshotPollIntervalSeconds() {
    return env.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS;
  }

  get runnerId() {
    return env.TRIGGER_RUNNER_ID;
  }

  get successExitCode() {
    return env.TRIGGER_SUCCESS_EXIT_CODE;
  }

  get failureExitCode() {
    return env.TRIGGER_FAILURE_EXIT_CODE;
  }

  get workerApiUrl() {
    return env.TRIGGER_SUPERVISOR_API_URL;
  }

  get workerInstanceName() {
    return env.TRIGGER_WORKER_INSTANCE_NAME;
  }

  private state:
    | {
        phase: "RUN";
        run: Run;
        snapshot: Snapshot;
      }
    | {
        phase: "IDLE" | "WARM_START";
      } = { phase: "IDLE" };

  constructor(opts: ManagedRunControllerOptions) {
    this.workerManifest = opts.workerManifest;

    this.httpClient = new WorkloadHttpClient({
      workerApiUrl: this.workerApiUrl,
      runnerId: this.runnerId,
      deploymentId: env.TRIGGER_DEPLOYMENT_ID,
      deploymentVersion: env.TRIGGER_DEPLOYMENT_VERSION,
      projectRef: env.TRIGGER_PROJECT_REF,
    });

    const properties = {
      ...env.raw,
      TRIGGER_POD_SCHEDULED_AT_MS: env.TRIGGER_POD_SCHEDULED_AT_MS.toISOString(),
      TRIGGER_DEQUEUED_AT_MS: env.TRIGGER_DEQUEUED_AT_MS.toISOString(),
    };

    this.sendDebugLog({
      runId: env.TRIGGER_RUN_ID,
      message: "Creating run controller",
      properties,
    });

    if (env.TRIGGER_METADATA_URL) {
      this.metadataClient = new MetadataClient(env.TRIGGER_METADATA_URL);
    }

    if (env.TRIGGER_WARM_START_URL) {
      this.warmStartClient = new WarmStartClient({
        apiUrl: new URL(env.TRIGGER_WARM_START_URL),
        controllerId: env.TRIGGER_WORKLOAD_CONTROLLER_ID,
        deploymentId: env.TRIGGER_DEPLOYMENT_ID,
        deploymentVersion: env.TRIGGER_DEPLOYMENT_VERSION,
        machineCpu: env.TRIGGER_MACHINE_CPU,
        machineMemory: env.TRIGGER_MACHINE_MEMORY,
      });
    }

    this.snapshotPoller = new HeartbeatService({
      heartbeat: async () => {
        if (!this.runFriendlyId) {
          this.sendDebugLog({
            runId: env.TRIGGER_RUN_ID,
            message: "Skipping snapshot poll, no run ID",
          });
          return;
        }

        this.sendDebugLog({
          runId: env.TRIGGER_RUN_ID,
          message: "Polling for latest snapshot",
        });

        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: `snapshot poll: started`,
          properties: {
            snapshotId: this.snapshotFriendlyId,
          },
        });

        const response = await this.httpClient.getRunExecutionData(this.runFriendlyId);

        if (!response.success) {
          this.sendDebugLog({
            runId: this.runFriendlyId,
            message: "Snapshot poll failed",
            properties: {
              error: response.error,
            },
          });

          this.sendDebugLog({
            runId: this.runFriendlyId,
            message: `snapshot poll: failed`,
            properties: {
              snapshotId: this.snapshotFriendlyId,
              error: response.error,
            },
          });

          return;
        }

        await this.handleSnapshotChange(response.data.execution);
      },
      intervalMs: this.snapshotPollIntervalSeconds * 1000,
      leadingEdge: false,
      onError: async (error) => {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "Failed to poll for snapshot",
          properties: { error: error instanceof Error ? error.message : String(error) },
        });
      },
    });

    this.runHeartbeat = new HeartbeatService({
      heartbeat: async () => {
        if (!this.runFriendlyId || !this.snapshotFriendlyId) {
          this.sendDebugLog({
            runId: this.runFriendlyId,
            message: "Skipping heartbeat, no run ID or snapshot ID",
          });
          return;
        }

        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "heartbeat: started",
        });

        const response = await this.httpClient.heartbeatRun(
          this.runFriendlyId,
          this.snapshotFriendlyId
        );

        if (!response.success) {
          this.sendDebugLog({
            runId: this.runFriendlyId,
            message: "heartbeat: failed",
            properties: {
              error: response.error,
            },
          });
        }
      },
      intervalMs: this.heartbeatIntervalSeconds * 1000,
      leadingEdge: false,
      onError: async (error) => {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "Failed to send heartbeat",
          properties: { error: error instanceof Error ? error.message : String(error) },
        });
      },
    });

    process.on("SIGTERM", async () => {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "Received SIGTERM, stopping worker",
      });
      await this.stop();
    });
  }

  private enterRunPhase(run: Run, snapshot: Snapshot) {
    this.onExitRunPhase(run);
    this.state = { phase: "RUN", run, snapshot };

    this.runHeartbeat.start();
    this.snapshotPoller.start();
  }

  private enterWarmStartPhase() {
    this.onExitRunPhase();
    this.state = { phase: "WARM_START" };
  }

  // This should only be used when we're already executing a run. Attempt number changes are not allowed.
  private updateRunPhase(run: Run, snapshot: Snapshot) {
    if (this.state.phase !== "RUN") {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: `updateRunPhase: Invalid phase for updating snapshot: ${this.state.phase}`,
        properties: {
          currentPhase: this.state.phase,
          snapshotId: snapshot.friendlyId,
        },
      });

      throw new Error(`Invalid phase for updating snapshot: ${this.state.phase}`);
    }

    if (this.state.run.friendlyId !== run.friendlyId) {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: `updateRunPhase: Mismatched run IDs`,
        properties: {
          currentRunId: this.state.run.friendlyId,
          newRunId: run.friendlyId,
          currentSnapshotId: this.state.snapshot.friendlyId,
          newSnapshotId: snapshot.friendlyId,
        },
      });

      throw new Error("Mismatched run IDs");
    }

    if (this.state.snapshot.friendlyId === snapshot.friendlyId) {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: "updateRunPhase: Snapshot not changed",
        properties: { run: run.friendlyId, snapshot: snapshot.friendlyId },
      });

      this.sendDebugLog({
        runId: run.friendlyId,
        message: `updateRunPhase: Snapshot not changed`,
        properties: {
          snapshotId: snapshot.friendlyId,
        },
      });

      return;
    }

    if (this.state.run.attemptNumber !== run.attemptNumber) {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: `updateRunPhase: Attempt number changed`,
        properties: {
          oldAttemptNumber: this.state.run.attemptNumber ?? undefined,
          newAttemptNumber: run.attemptNumber ?? undefined,
        },
      });
      throw new Error("Attempt number changed");
    }

    this.state = {
      phase: "RUN",
      run: {
        friendlyId: run.friendlyId,
        attemptNumber: run.attemptNumber,
      },
      snapshot: {
        friendlyId: snapshot.friendlyId,
      },
    };
  }

  private onExitRunPhase(newRun: Run | undefined = undefined) {
    // We're not in a run phase, nothing to do
    if (this.state.phase !== "RUN") {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "onExitRunPhase: Not in run phase, skipping",
        properties: { phase: this.state.phase },
      });
      return;
    }

    // This is still the same run, so we're not exiting the phase
    if (newRun?.friendlyId === this.state.run.friendlyId) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "onExitRunPhase: Same run, skipping",
        properties: { newRun: newRun?.friendlyId },
      });
      return;
    }

    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "onExitRunPhase: Exiting run phase",
      properties: { newRun: newRun?.friendlyId },
    });

    this.runHeartbeat.stop();
    this.snapshotPoller.stop();

    const { run, snapshot } = this.state;

    this.unsubscribeFromRunNotifications({ run, snapshot });
  }

  private subscribeToRunNotifications({ run, snapshot }: { run: Run; snapshot: Snapshot }) {
    this.socket.emit("run:start", {
      version: "1",
      run: {
        friendlyId: run.friendlyId,
      },
      snapshot: {
        friendlyId: snapshot.friendlyId,
      },
    });
  }

  private unsubscribeFromRunNotifications({ run, snapshot }: { run: Run; snapshot: Snapshot }) {
    this.socket.emit("run:stop", {
      version: "1",
      run: {
        friendlyId: run.friendlyId,
      },
      snapshot: {
        friendlyId: snapshot.friendlyId,
      },
    });
  }

  private get runFriendlyId() {
    if (this.state.phase !== "RUN") {
      return undefined;
    }

    return this.state.run.friendlyId;
  }

  private get snapshotFriendlyId() {
    if (this.state.phase !== "RUN") {
      return;
    }

    return this.state.snapshot.friendlyId;
  }

  private handleSnapshotChangeLock = false;

  private async handleSnapshotChange({
    run,
    snapshot,
    completedWaitpoints,
  }: Pick<RunExecutionData, "run" | "snapshot" | "completedWaitpoints">) {
    if (this.handleSnapshotChangeLock) {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: "handleSnapshotChange: already in progress",
      });
      return;
    }

    this.handleSnapshotChangeLock = true;

    try {
      if (!this.snapshotFriendlyId) {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "handleSnapshotChange: Missing snapshot ID",
          properties: {
            newSnapshotId: snapshot.friendlyId,
            newSnapshotStatus: snapshot.executionStatus,
          },
        });

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "snapshot change: missing snapshot ID",
          properties: {
            newSnapshotId: snapshot.friendlyId,
            newSnapshotStatus: snapshot.executionStatus,
          },
        });

        return;
      }

      if (this.snapshotFriendlyId === snapshot.friendlyId) {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "handleSnapshotChange: snapshot not changed, skipping",
          properties: { snapshot: snapshot.friendlyId },
        });

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "snapshot change: skipping, no change",
          properties: {
            snapshotId: this.snapshotFriendlyId,
            snapshotStatus: snapshot.executionStatus,
          },
        });

        return;
      }

      this.sendDebugLog({
        runId: run.friendlyId,
        message: `snapshot change: ${snapshot.executionStatus}`,
        properties: {
          oldSnapshotId: this.snapshotFriendlyId,
          newSnapshotId: snapshot.friendlyId,
          completedWaitpoints: completedWaitpoints.length,
        },
      });

      try {
        this.updateRunPhase(run, snapshot);
      } catch (error) {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "snapshot change: failed to update run phase",
          properties: {
            currentPhase: this.state.phase,
            error: error instanceof Error ? error.message : String(error),
          },
        });

        this.waitForNextRun();
        return;
      }

      switch (snapshot.executionStatus) {
        case "PENDING_CANCEL": {
          try {
            await this.cancelAttempt(run.friendlyId);
          } catch (error) {
            this.sendDebugLog({
              runId: run.friendlyId,
              message: "snapshot change: failed to cancel attempt",
              properties: {
                error: error instanceof Error ? error.message : String(error),
              },
            });

            this.waitForNextRun();
            return;
          }

          return;
        }
        case "FINISHED": {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Run is finished, will wait for next run",
          });

          if (this.activeRunExecution) {
            // Let's pretend we've just suspended the run. This will kill the process and should automatically wait for the next run.
            // We still explicitly call waitForNextRun() afterwards in case of race conditions. Locks will prevent this from causing issues.
            await this.taskRunProcess?.suspend();
          }

          this.waitForNextRun();

          return;
        }
        case "QUEUED_EXECUTING":
        case "EXECUTING_WITH_WAITPOINTS": {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Run is executing with waitpoints",
            properties: { snapshot: snapshot.friendlyId },
          });

          try {
            // This should never throw. It should also never fail the run.
            await this.taskRunProcess?.cleanup(false);
          } catch (error) {
            this.sendDebugLog({
              runId: run.friendlyId,
              message: "Failed to cleanup task run process",
              properties: { error: error instanceof Error ? error.message : String(error) },
            });
          }

          if (snapshot.friendlyId !== this.snapshotFriendlyId) {
            this.sendDebugLog({
              runId: run.friendlyId,
              message: "Snapshot changed after cleanup, abort",
              properties: {
                oldSnapshotId: snapshot.friendlyId,
                newSnapshotId: this.snapshotFriendlyId,
              },
            });
            return;
          }

          await sleep(env.TRIGGER_PRE_SUSPEND_WAIT_MS);

          if (snapshot.friendlyId !== this.snapshotFriendlyId) {
            this.sendDebugLog({
              runId: run.friendlyId,
              message: "Snapshot changed after suspend threshold, abort",
              properties: {
                oldSnapshotId: snapshot.friendlyId,
                newSnapshotId: this.snapshotFriendlyId,
              },
            });
            return;
          }

          if (!this.runFriendlyId || !this.snapshotFriendlyId) {
            this.sendDebugLog({
              runId: run.friendlyId,
              message:
                "handleSnapshotChange: Missing run ID or snapshot ID after suspension, abort",
              properties: {
                runId: this.runFriendlyId,
                snapshotId: this.snapshotFriendlyId,
              },
            });
            return;
          }

          const suspendResult = await this.httpClient.suspendRun(
            this.runFriendlyId,
            this.snapshotFriendlyId
          );

          if (!suspendResult.success) {
            this.sendDebugLog({
              runId: run.friendlyId,
              message: "Failed to suspend run, staying alive 🎶",
              properties: {
                error: suspendResult.error,
              },
            });

            this.sendDebugLog({
              runId: run.friendlyId,
              message: "checkpoint: suspend request failed",
              properties: {
                snapshotId: snapshot.friendlyId,
                error: suspendResult.error,
              },
            });

            return;
          }

          if (!suspendResult.data.ok) {
            this.sendDebugLog({
              runId: run.friendlyId,
              message: "checkpoint: failed to suspend run",
              properties: {
                snapshotId: snapshot.friendlyId,
                error: suspendResult.data.error,
              },
            });

            return;
          }

          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Suspending, any day now 🚬",
            properties: { ok: suspendResult.data.ok },
          });
          return;
        }
        case "SUSPENDED": {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Run was suspended, kill the process and wait for more runs",
            properties: { run: run.friendlyId, snapshot: snapshot.friendlyId },
          });

          // This will kill the process and fail the execution with a SuspendedProcessError
          await this.taskRunProcess?.suspend();

          return;
        }
        case "PENDING_EXECUTING": {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Run is pending execution",
            properties: { run: run.friendlyId, snapshot: snapshot.friendlyId },
          });

          if (completedWaitpoints.length === 0) {
            this.sendDebugLog({
              runId: run.friendlyId,
              message: "No waitpoints to complete, nothing to do",
            });
            return;
          }

          // There are waitpoints to complete so we've been restored after being suspended

          // Short delay to give websocket time to reconnect
          await sleep(100);

          // Env may have changed after restore
          await this.processEnvOverrides();

          // We need to let the platform know we're ready to continue
          const continuationResult = await this.httpClient.continueRunExecution(
            run.friendlyId,
            snapshot.friendlyId
          );

          if (!continuationResult.success) {
            this.sendDebugLog({
              runId: run.friendlyId,
              message: "failed to continue execution",
              properties: {
                error: continuationResult.error,
              },
            });

            this.waitForNextRun();
            return;
          }

          return;
        }
        case "EXECUTING": {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Run is now executing",
            properties: { run: run.friendlyId, snapshot: snapshot.friendlyId },
          });

          if (completedWaitpoints.length === 0) {
            return;
          }

          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Processing completed waitpoints",
            properties: { completedWaitpoints: completedWaitpoints.length },
          });

          if (!this.taskRunProcess) {
            this.sendDebugLog({
              runId: run.friendlyId,
              message: "No task run process, ignoring completed waitpoints",
              properties: { completedWaitpoints: completedWaitpoints.length },
            });
            return;
          }

          for (const waitpoint of completedWaitpoints) {
            this.taskRunProcess.waitpointCompleted(waitpoint);
          }

          return;
        }
        case "RUN_CREATED":
        case "QUEUED": {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Status change not handled",
            properties: { status: snapshot.executionStatus },
          });
          return;
        }
        default: {
          assertExhaustive(snapshot.executionStatus);
        }
      }
    } catch (error) {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: "snapshot change: unexpected error",
        properties: {
          snapshotId: snapshot.friendlyId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.handleSnapshotChangeLock = false;
    }
  }

  private async processEnvOverrides() {
    if (!this.metadataClient) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "No metadata client, skipping env overrides",
      });
      return;
    }

    const overrides = await this.metadataClient.getEnvOverrides();

    if (!overrides) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "No env overrides, skipping",
      });
      return;
    }

    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "Processing env overrides",
      properties: { ...overrides },
    });

    // Override the env with the new values
    env.override(overrides);

    // Update services and clients with the new values
    if (overrides.TRIGGER_HEARTBEAT_INTERVAL_SECONDS) {
      this.runHeartbeat.updateInterval(env.TRIGGER_HEARTBEAT_INTERVAL_SECONDS * 1000);
    }
    if (overrides.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS) {
      this.snapshotPoller.updateInterval(env.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS * 1000);
    }
    if (
      overrides.TRIGGER_SUPERVISOR_API_PROTOCOL ||
      overrides.TRIGGER_SUPERVISOR_API_DOMAIN ||
      overrides.TRIGGER_SUPERVISOR_API_PORT
    ) {
      this.httpClient.updateApiUrl(this.workerApiUrl);
    }
    if (overrides.TRIGGER_RUNNER_ID) {
      this.httpClient.updateRunnerId(this.runnerId);
    }
  }

  private activeRunExecution: Promise<void> | null = null;

  private async startAndExecuteRunAttempt({
    runFriendlyId,
    snapshotFriendlyId,
    dequeuedAt,
    podScheduledAt,
    isWarmStart,
    skipLockCheckForImmediateRetry: skipLockCheck,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    dequeuedAt?: Date;
    podScheduledAt?: Date;
    isWarmStart?: boolean;
    skipLockCheckForImmediateRetry?: boolean;
  }) {
    if (!skipLockCheck && this.activeRunExecution) {
      this.sendDebugLog({
        runId: runFriendlyId,
        message: "startAndExecuteRunAttempt: already in progress",
      });
      return;
    }

    const execution = async () => {
      if (!this.socket) {
        this.sendDebugLog({
          runId: runFriendlyId,
          message: "Starting run without socket connection",
        });
      }

      this.subscribeToRunNotifications({
        run: { friendlyId: runFriendlyId },
        snapshot: { friendlyId: snapshotFriendlyId },
      });

      const attemptStartedAt = Date.now();

      const start = await this.httpClient.startRunAttempt(runFriendlyId, snapshotFriendlyId, {
        isWarmStart,
      });

      if (!start.success) {
        this.sendDebugLog({
          runId: runFriendlyId,
          message: "Failed to start run",
          properties: { error: start.error },
        });

        this.sendDebugLog({
          runId: runFriendlyId,
          message: "failed to start run attempt",
          properties: {
            error: start.error,
          },
        });

        this.waitForNextRun();
        return;
      }

      const attemptDuration = Date.now() - attemptStartedAt;

      const { run, snapshot, execution, envVars } = start.data;

      this.sendDebugLog({
        runId: run.friendlyId,
        message: "Started run",
        properties: { snapshot: snapshot.friendlyId },
      });

      this.enterRunPhase(run, snapshot);

      const metrics = [
        {
          name: "start",
          event: "create_attempt",
          timestamp: attemptStartedAt,
          duration: attemptDuration,
        },
      ]
        .concat(
          dequeuedAt
            ? [
                {
                  name: "start",
                  event: "dequeue",
                  timestamp: dequeuedAt.getTime(),
                  duration: 0,
                },
              ]
            : []
        )
        .concat(
          podScheduledAt
            ? [
                {
                  name: "start",
                  event: "pod_scheduled",
                  timestamp: podScheduledAt.getTime(),
                  duration: 0,
                },
              ]
            : []
        ) satisfies TaskRunExecutionMetrics;

      const taskRunEnv = {
        ...env.gatherProcessEnv(),
        ...envVars,
      };

      try {
        return await this.executeRun({
          run,
          snapshot,
          envVars: taskRunEnv,
          execution,
          metrics,
          isWarmStart,
        });
      } catch (error) {
        if (error instanceof SuspendedProcessError) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Run was suspended and task run process was killed, waiting for next run",
            properties: { run: run.friendlyId, snapshot: snapshot.friendlyId },
          });

          this.waitForNextRun();
          return;
        }

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Error while executing attempt",
          properties: { error: error instanceof Error ? error.message : String(error) },
        });

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Submitting attempt completion",
          properties: {
            snapshotId: snapshot.friendlyId,
            updatedSnapshotId: this.snapshotFriendlyId,
          },
        });

        const completion = {
          id: execution.run.id,
          ok: false,
          retry: undefined,
          error: TaskRunProcess.parseExecuteError(error),
        } satisfies TaskRunFailedExecutionResult;

        const completionResult = await this.httpClient.completeRunAttempt(
          run.friendlyId,
          // FIXME: if the snapshot has changed since starting the run, this won't be accurate
          // ..but we probably shouldn't fetch the latest snapshot either because we may be in an "unhealthy" state while the next runner has already taken over
          this.snapshotFriendlyId ?? snapshot.friendlyId,
          { completion }
        );

        if (!completionResult.success) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Failed to submit completion after error",
            properties: { error: completionResult.error },
          });

          this.sendDebugLog({
            runId: run.friendlyId,
            message: "completion: failed to submit after error",
            properties: {
              error: completionResult.error,
            },
          });

          this.waitForNextRun();
          return;
        }

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Attempt completion submitted after error",
          properties: {
            attemptStatus: completionResult.data.result.attemptStatus,
            runId: completionResult.data.result.run.friendlyId,
            snapshotId: completionResult.data.result.snapshot.friendlyId,
          },
        });

        try {
          await this.handleCompletionResult(completion, completionResult.data.result);
        } catch (error) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Failed to handle completion result after error",
            properties: { error: error instanceof Error ? error.message : String(error) },
          });

          this.waitForNextRun();
          return;
        }
      }
    };

    this.activeRunExecution = execution();

    try {
      await this.activeRunExecution;
    } catch (error) {
      this.sendDebugLog({
        runId: runFriendlyId,
        message: "startAndExecuteRunAttempt: unexpected error",
        properties: { error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      this.activeRunExecution = null;
    }
  }

  private waitForNextRunLock = false;

  /** This will kill the child process before spinning up a new one. It will never throw,
   *  but may exit the process on any errors or when no runs are available after the
   *  configured duration. */
  private async waitForNextRun() {
    if (this.waitForNextRunLock) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "waitForNextRun: already in progress",
      });
      return;
    }

    this.waitForNextRunLock = true;
    const previousRunId = this.runFriendlyId;

    try {
      // If there's a run execution in progress, we need to kill it and wait for it to finish
      if (this.activeRunExecution) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "waitForNextRun: waiting for existing run execution to finish",
        });
        await this.activeRunExecution;
      }

      // Just for good measure
      await this.taskRunProcess?.kill("SIGKILL");

      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "waitForNextRun: waiting for next run",
      });

      this.enterWarmStartPhase();

      if (!this.warmStartClient) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "waitForNextRun: warm starts disabled, shutting down",
        });
        this.exitProcess(this.successExitCode);
      }

      if (this.taskRunProcess) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "waitForNextRun: eagerly recreating task run process with options",
        });
        this.taskRunProcess = new TaskRunProcess({
          ...this.taskRunProcess.options,
          isWarmStart: true,
        }).initialize();
      } else {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "waitForNextRun: no existing task run process, so we can't eagerly recreate it",
        });
      }

      // Check the service is up and get additional warm start config
      const connect = await this.warmStartClient.connect();

      if (!connect.success) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "waitForNextRun: failed to connect to warm start service",
          properties: {
            warmStartUrl: env.TRIGGER_WARM_START_URL,
            error: connect.error,
          },
        });
        this.exitProcess(this.successExitCode);
      }

      const connectionTimeoutMs =
        connect.data.connectionTimeoutMs ?? env.TRIGGER_WARM_START_CONNECTION_TIMEOUT_MS;
      const keepaliveMs = connect.data.keepaliveMs ?? env.TRIGGER_WARM_START_KEEPALIVE_MS;

      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "waitForNextRun: connected to warm start service",
        properties: {
          connectionTimeoutMs,
          keepaliveMs,
        },
      });

      if (previousRunId) {
        this.sendDebugLog({
          runId: previousRunId,
          message: "warm start: received config",
          properties: {
            connectionTimeoutMs,
            keepaliveMs,
          },
        });
      }

      if (!connectionTimeoutMs || !keepaliveMs) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "waitForNextRun: warm starts disabled after connect",
          properties: {
            connectionTimeoutMs,
            keepaliveMs,
          },
        });
        this.exitProcess(this.successExitCode);
      }

      const nextRun = await this.warmStartClient.warmStart({
        workerInstanceName: this.workerInstanceName,
        connectionTimeoutMs,
        keepaliveMs,
      });

      if (!nextRun) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "waitForNextRun: warm start failed, shutting down",
        });
        this.exitProcess(this.successExitCode);
      }

      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "waitForNextRun: got next run",
        properties: { nextRun: nextRun.run.friendlyId },
      });

      this.startAndExecuteRunAttempt({
        runFriendlyId: nextRun.run.friendlyId,
        snapshotFriendlyId: nextRun.snapshot.friendlyId,
        dequeuedAt: nextRun.dequeuedAt,
        isWarmStart: true,
      }).finally(() => {});
      return;
    } catch (error) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "waitForNextRun: unexpected error",
        properties: { error: error instanceof Error ? error.message : String(error) },
      });
      this.exitProcess(this.failureExitCode);
    } finally {
      this.waitForNextRunLock = false;
    }
  }

  private exitProcess(code?: number): never {
    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "Exiting process",
      properties: { code },
    });
    if (this.taskRunProcess?.isPreparedForNextRun) {
      this.taskRunProcess.forceExit();
    }
    process.exit(code);
  }

  createSocket() {
    const wsUrl = new URL("/workload", this.workerApiUrl);

    this.socket = io(wsUrl.href, {
      transports: ["websocket"],
      extraHeaders: {
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: env.TRIGGER_DEPLOYMENT_ID,
        [WORKLOAD_HEADERS.RUNNER_ID]: env.TRIGGER_RUNNER_ID,
      },
    });
    this.socket.on("run:notify", async ({ version, run }) => {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: "run:notify received by runner",
        properties: { version, runId: run.friendlyId },
      });

      if (!this.runFriendlyId) {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "run:notify: ignoring notification, no local run ID",
          properties: {
            currentRunId: this.runFriendlyId,
            currentSnapshotId: this.snapshotFriendlyId,
          },
        });
        return;
      }

      if (run.friendlyId !== this.runFriendlyId) {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "run:notify: ignoring notification for different run",
          properties: {
            currentRunId: this.runFriendlyId,
            currentSnapshotId: this.snapshotFriendlyId,
            notificationRunId: run.friendlyId,
          },
        });
        return;
      }

      // Reset the (fallback) snapshot poll interval so we don't do unnecessary work
      this.snapshotPoller.resetCurrentInterval();

      const latestSnapshot = await this.httpClient.getRunExecutionData(this.runFriendlyId);

      if (!latestSnapshot.success) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "run:notify: failed to get latest snapshot data",
          properties: {
            currentRunId: this.runFriendlyId,
            currentSnapshotId: this.snapshotFriendlyId,
            error: latestSnapshot.error,
          },
        });
        return;
      }

      await this.handleSnapshotChange(latestSnapshot.data.execution);
    });
    this.socket.on("connect", () => {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "Connected to supervisor",
      });

      // This should handle the case where we reconnect after being restored
      if (this.state.phase === "RUN") {
        const { run, snapshot } = this.state;
        this.subscribeToRunNotifications({ run, snapshot });
      }
    });
    this.socket.on("connect_error", (error) => {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "Connection error",
        properties: { error: error instanceof Error ? error.message : String(error) },
      });
    });
    this.socket.on("disconnect", (reason, description) => {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "Disconnected from supervisor",
        properties: { reason, description: description?.toString() },
      });
    });
  }

  private async executeRun({
    run,
    snapshot,
    envVars,
    execution,
    metrics,
    isWarmStart,
  }: WorkloadRunAttemptStartResponseBody & {
    metrics?: TaskRunExecutionMetrics;
    isWarmStart?: boolean;
  }) {
    this.snapshotPoller.start();

    if (!this.taskRunProcess || !this.taskRunProcess.isPreparedForNextRun) {
      this.taskRunProcess = new TaskRunProcess({
        workerManifest: this.workerManifest,
        env: envVars,
        serverWorker: {
          id: "unmanaged",
          contentHash: env.TRIGGER_CONTENT_HASH,
          version: env.TRIGGER_DEPLOYMENT_VERSION,
          engine: "V2",
        },
        machine: execution.machine,
        isWarmStart,
      }).initialize();
    }

    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "executing task run process",
      properties: {
        attemptId: execution.attempt.id,
        runId: execution.run.id,
      },
    });

    const completion = await this.taskRunProcess.execute(
      {
        payload: {
          execution,
          traceContext: execution.run.traceContext ?? {},
          metrics,
        },
        messageId: run.friendlyId,
        env: envVars,
      },
      isWarmStart
    );

    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "Completed run",
      properties: { completion: completion.ok },
    });

    try {
      // The execution has finished, so we can cleanup the task run process. Killing it should be safe.
      await this.taskRunProcess.cleanup(true);
    } catch (error) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "Failed to cleanup task run process, submitting completion anyway",
        properties: { error: error instanceof Error ? error.message : String(error) },
      });
    }

    if (!this.runFriendlyId || !this.snapshotFriendlyId) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "executeRun: Missing run ID or snapshot ID after execution",
        properties: {
          runId: this.runFriendlyId,
          snapshotId: this.snapshotFriendlyId,
        },
      });

      this.waitForNextRun();
      return;
    }

    const completionResult = await this.httpClient.completeRunAttempt(
      this.runFriendlyId,
      this.snapshotFriendlyId,
      {
        completion,
      }
    );

    if (!completionResult.success) {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: "completion: failed to submit",
        properties: {
          error: completionResult.error,
        },
      });

      this.sendDebugLog({
        runId: run.friendlyId,
        message: "completion: failed to submit",
        properties: {
          error: completionResult.error,
        },
      });

      this.waitForNextRun();
      return;
    }

    this.sendDebugLog({
      runId: run.friendlyId,
      message: "Attempt completion submitted",
      properties: {
        attemptStatus: completionResult.data.result.attemptStatus,
        runId: completionResult.data.result.run.friendlyId,
        snapshotId: completionResult.data.result.snapshot.friendlyId,
      },
    });

    try {
      await this.handleCompletionResult(completion, completionResult.data.result);
    } catch (error) {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: "Failed to handle completion result",
        properties: { error: error instanceof Error ? error.message : String(error) },
      });

      this.waitForNextRun();
      return;
    }
  }

  private async handleCompletionResult(
    completion: TaskRunExecutionResult,
    result: CompleteRunAttemptResult
  ) {
    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "Handling completion result",
      properties: {
        completion: completion.ok,
        attemptStatus: result.attemptStatus,
        snapshotId: result.snapshot.friendlyId,
        runId: result.run.friendlyId,
      },
    });

    const { attemptStatus, snapshot: completionSnapshot, run } = result;

    try {
      this.updateRunPhase(run, completionSnapshot);
    } catch (error) {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: "Failed to update run phase after completion",
        properties: { error: error instanceof Error ? error.message : String(error) },
      });

      this.waitForNextRun();
      return;
    }

    if (attemptStatus === "RUN_FINISHED") {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: "Run finished",
      });

      this.waitForNextRun();
      return;
    }

    if (attemptStatus === "RUN_PENDING_CANCEL") {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: "Run pending cancel",
      });
      return;
    }

    if (attemptStatus === "RETRY_QUEUED") {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: "Retry queued",
      });

      this.waitForNextRun();
      return;
    }

    if (attemptStatus === "RETRY_IMMEDIATELY") {
      if (completion.ok) {
        throw new Error("Should retry but completion OK.");
      }

      if (!completion.retry) {
        throw new Error("Should retry but missing retry params.");
      }

      await sleep(completion.retry.delay);

      if (!this.snapshotFriendlyId) {
        throw new Error("Missing snapshot ID after retry");
      }

      this.startAndExecuteRunAttempt({
        runFriendlyId: run.friendlyId,
        snapshotFriendlyId: this.snapshotFriendlyId,
        skipLockCheckForImmediateRetry: true,
        isWarmStart: true,
      }).finally(() => {});
      return;
    }

    assertExhaustive(attemptStatus);
  }

  sendDebugLog({
    runId,
    message,
    date,
    properties,
  }: {
    runId?: string;
    message: string;
    date?: Date;
    properties?: WorkloadDebugLogRequestBody["properties"];
  }) {
    if (!runId) {
      runId = this.runFriendlyId;
    }

    if (!runId) {
      runId = env.TRIGGER_RUN_ID;
    }

    if (!runId) {
      return;
    }

    const mergedProperties = {
      ...properties,
      runId,
      runnerId: this.runnerId,
      workerName: this.workerInstanceName,
    };

    console.log(message, mergedProperties);

    this.httpClient.sendDebugLog(runId, {
      message,
      time: date ?? new Date(),
      properties: mergedProperties,
    });
  }

  async cancelAttempt(runId: string) {
    this.sendDebugLog({
      runId,
      message: "cancelling attempt",
      properties: { runId },
    });

    await this.taskRunProcess?.cancel();
  }

  async start() {
    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "Starting up",
    });

    // Websocket notifications are only an optimisation so we don't need to wait for a successful connection
    this.createSocket();

    // If we have run and snapshot IDs, we can start an attempt immediately
    if (env.TRIGGER_RUN_ID && env.TRIGGER_SNAPSHOT_ID) {
      this.startAndExecuteRunAttempt({
        runFriendlyId: env.TRIGGER_RUN_ID,
        snapshotFriendlyId: env.TRIGGER_SNAPSHOT_ID,
        dequeuedAt: env.TRIGGER_DEQUEUED_AT_MS,
        podScheduledAt: env.TRIGGER_POD_SCHEDULED_AT_MS,
      }).finally(() => {});
      return;
    }

    // ..otherwise we need to wait for a run
    this.waitForNextRun();
    return;
  }

  async stop() {
    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "Shutting down",
    });

    if (this.taskRunProcess) {
      await this.taskRunProcess.cleanup(true);
    }

    this.runHeartbeat.stop();
    this.snapshotPoller.stop();

    this.socket.close();
  }
}

const workerManifest = await loadWorkerManifest();

const prodWorker = new ManagedRunController({ workerManifest });
await prodWorker.start();

async function loadWorkerManifest() {
  const manifest = await readJSONFile("./index.json");
  return WorkerManifest.parse(manifest);
}
