import type { WorkerManifest } from "@trigger.dev/core/v3";
import { generateFriendlyId } from "@trigger.dev/core/v3";
import { TaskRunProcess, TRUST_STORE_ENV_KEYS } from "../../executions/taskRunProcess.js";
import { OWN_CGROUP_OOM_KILL_COUNTER } from "../../executions/oomKills.js";
import type { RunnerEnv } from "./env.js";
import type { RunLogger, SendDebugLogOptions } from "./logger.js";

// Run env keys the task process needs in its fork env: it reads them before its first
// EXECUTE_TASK_RUN message, or that message does not carry them. None of them are secrets.
const FORK_ENV_KEYS = [
  ...TRUST_STORE_ENV_KEYS,
  // Node, OpenSSL and the dynamic loader read these only at process start.
  "NODE_PATH",
  "NODE_ICU_DATA",
  "OPENSSL_CONF",
  "OPENSSL_MODULES",
  "SSL_CERT_DIR",
  "LANG",
  "LC_ALL",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  // Node also applies a later change to TZ, but code that runs before the run's env arrives needs it.
  "TZ",
  "TRIGGER_PROJECT_REF",
  "TRIGGER_LOG_LEVEL",
  "TRIGGER_WAIT_UNTIL_TIMEOUT_MS",
  "OTEL_IMPORT_HOOK_EXCLUDES",
  "TRIGGER_OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT",
  "TRIGGER_OTEL_LOG_ATTRIBUTE_COUNT_LIMIT",
  "TRIGGER_OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT",
  "TRIGGER_OTEL_LOG_ATTRIBUTE_VALUE_LENGTH_LIMIT",
  "TRIGGER_OTEL_SPAN_EVENT_COUNT_LIMIT",
  "TRIGGER_OTEL_LINK_COUNT_LIMIT",
  "TRIGGER_OTEL_ATTRIBUTE_PER_LINK_COUNT_LIMIT",
  "TRIGGER_OTEL_ATTRIBUTE_PER_EVENT_COUNT_LIMIT",
] as const;

// libuv reads its settings (UV_THREADPOOL_SIZE, UV_USE_IO_URING and others) when it starts.
const FORK_ENV_PREFIXES = ["UV_"] as const;

// With NODE_USE_ENV_PROXY set, Node reads the proxy settings only at process start. Proxy URLs can
// carry credentials, so these go in the fork env only when the run opts in.
const ENV_PROXY_KEYS = [
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/** The part of a run's env that goes in the task process's fork env. The rest goes only over IPC. */
export function forkEnvFromRunEnv(runEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const keys =
    runEnv.NODE_USE_ENV_PROXY === "1" ? [...FORK_ENV_KEYS, ...ENV_PROXY_KEYS] : FORK_ENV_KEYS;
  for (const key of keys) {
    const value = runEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(runEnv)) {
    if (FORK_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}

export interface TaskRunProcessProviderOptions {
  workerManifest: WorkerManifest;
  env: RunnerEnv;
  logger: RunLogger;
  processKeepAliveEnabled: boolean;
  processKeepAliveMaxExecutionCount: number;
}

export interface GetProcessOptions {
  taskRunEnv: Record<string, string>;
  isWarmStart?: boolean;
}

export class TaskRunProcessProvider {
  private readonly workerManifest: WorkerManifest;
  private readonly env: RunnerEnv;
  private readonly logger: RunLogger;
  private readonly processKeepAliveEnabled: boolean;
  private readonly processKeepAliveMaxExecutionCount: number;
  private readonly machineId = generateFriendlyId("machine");

  // Process keep-alive state
  private persistentProcess: TaskRunProcess | null = null;
  private executionCount = 0;

  constructor(opts: TaskRunProcessProviderOptions) {
    this.workerManifest = opts.workerManifest;
    this.env = opts.env;
    this.logger = opts.logger;
    this.processKeepAliveEnabled = opts.processKeepAliveEnabled;
    this.processKeepAliveMaxExecutionCount = opts.processKeepAliveMaxExecutionCount;
  }

  get hasPersistentProcess(): boolean {
    return !!this.persistentProcess;
  }

  async handleImmediateRetry(): Promise<void> {
    if (!this.processKeepAliveEnabled) {
      // For immediate retries, we need to ensure we have a clean process
      if (this.persistentProcess) {
        // If the process is not prepared for the next attempt, we need to get a fresh one
        if (!this.persistentProcess.isPreparedForNextAttempt) {
          this.sendDebugLog(
            "existing task run process not prepared for retry, will get fresh process"
          );
          await this.persistentProcess.kill("SIGKILL");
          this.persistentProcess = null;
        }
      }
    }
  }

  /**
   * Gets a TaskRunProcess, either by reusing an existing one or creating a new one
   */
  async getProcess(opts: GetProcessOptions): Promise<TaskRunProcess> {
    this.sendDebugLog("Getting TaskRunProcess", {
      processKeepAliveEnabled: this.processKeepAliveEnabled,
      hasPersistentProcess: !!this.persistentProcess,
      executionCount: this.executionCount,
      maxExecutionCount: this.processKeepAliveMaxExecutionCount,
      isWarmStart: opts.isWarmStart,
    });

    // If process keep-alive is disabled, always create a new process
    if (!this.processKeepAliveEnabled) {
      this.sendDebugLog("Creating new TaskRunProcess (keep-alive disabled)");
      return this.createTaskRunProcess(opts);
    }

    // If process keep-alive is enabled and we have a healthy persistent process, reuse it
    if (this.shouldReusePersistentProcess()) {
      this.sendDebugLog("Reusing persistent TaskRunProcess", {
        executionCount: this.executionCount,
      });

      return this.persistentProcess!;
    }

    // Create new process (keep-alive enabled but no reusable process available)
    this.sendDebugLog("Creating new TaskRunProcess", {
      hadPersistentProcess: !!this.persistentProcess,
      reason: this.processKeepAliveEnabled
        ? "execution limit reached or unhealthy"
        : "keep-alive disabled",
    });

    const existingPersistentProcess = this.persistentProcess;

    // Clean up old persistent process if it exists
    if (existingPersistentProcess) {
      await this.cleanupProcess(existingPersistentProcess);
    }

    this.persistentProcess = this.createTaskRunProcess(opts);
    this.executionCount = 0;

    return this.persistentProcess;
  }

  /**
   * Returns a process after execution, handling keep-alive logic and cleanup
   */
  async returnProcess(process: TaskRunProcess): Promise<void> {
    this.sendDebugLog("Returning TaskRunProcess", {
      processKeepAliveEnabled: this.processKeepAliveEnabled,
      executionCount: this.executionCount,
      maxExecutionCount: this.processKeepAliveMaxExecutionCount,
    });

    if (!this.processKeepAliveEnabled) {
      // Keep-alive disabled - immediately cleanup the process
      this.sendDebugLog("Keep-alive disabled, cleaning up process immediately");
      await process.cleanup(true);
      return;
    }

    // Keep-alive enabled - check if we should keep the process alive
    if (this.shouldKeepProcessAlive(process)) {
      this.sendDebugLog("Keeping TaskRunProcess alive for next run", {
        executionCount: this.executionCount,
        maxExecutionCount: this.processKeepAliveMaxExecutionCount,
      });

      // Call cleanup(false) to prepare for next run but keep process alive
      await process.cleanup(false);
      this.persistentProcess = process;
      this.executionCount++;
    } else {
      this.sendDebugLog("Not keeping TaskRunProcess alive, cleaning up", {
        executionCount: this.executionCount,
        maxExecutionCount: this.processKeepAliveMaxExecutionCount,
        isHealthy: process.isHealthy,
      });

      // Cleanup the process completely
      await process.cleanup(true);
    }
  }

  async suspendProcess(flush: boolean, process?: TaskRunProcess): Promise<void> {
    if (this.persistentProcess) {
      if (process) {
        if (this.persistentProcess.pid === process.pid) {
          this.sendDebugLog("Suspending matching persistent TaskRunProcess (process provided)", {
            pid: process.pid,
            flush,
          });

          this.persistentProcess = null;
          this.executionCount = 0;

          await process.suspend({ flush });
        } else {
          this.sendDebugLog("Suspending TaskRunProcess (does not match persistent process)", {
            pid: process.pid,
            flush,
          });

          await process.suspend({ flush });
        }
      } else {
        this.sendDebugLog("Suspending persistent TaskRunProcess (no process provided)", {
          pid: this.persistentProcess.pid,
          flush,
        });

        this.persistentProcess = null;
        this.executionCount = 0;
      }
    } else {
      if (process) {
        this.sendDebugLog("Suspending non-persistent TaskRunProcess (process provided)", {
          pid: process.pid,
          flush,
        });

        await process.suspend({ flush });
      } else {
        this.sendDebugLog("Suspending non-persistent TaskRunProcess (no process provided)", {
          flush,
        });
      }
    }
  }

  /**
   * Handles process abort/kill scenarios
   */
  async handleProcessAbort(process: TaskRunProcess): Promise<void> {
    this.sendDebugLog("Handling process abort");

    // If this was our persistent process, clear it
    if (this.persistentProcess?.pid === process.pid) {
      this.persistentProcess = null;
      this.executionCount = 0;
    }

    // Kill the process
    await process.cleanup(true);
  }

  async killProcess(process: TaskRunProcess): Promise<void> {
    this.sendDebugLog("Killing process");

    // If this was our persistent process, clear it
    if (this.persistentProcess?.pid === process.pid) {
      this.persistentProcess = null;
      this.executionCount = 0;
    }

    // Kill the process
    await this.cleanupProcess(process);
  }

  /**
   * Forces cleanup of any persistent process
   */
  async cleanup() {
    if (this.persistentProcess) {
      this.sendDebugLog("cleanup() called");

      await this.cleanupProcess(this.persistentProcess);
    }
  }

  /**
   * Gets metrics about the provider state
   */
  get metrics() {
    return {
      processKeepAlive: {
        enabled: this.processKeepAliveEnabled,
        executionCount: this.executionCount,
        maxExecutionCount: this.processKeepAliveMaxExecutionCount,
        hasPersistentProcess: !!this.persistentProcess,
      },
    };
  }

  private createTaskRunProcess({ taskRunEnv, isWarmStart }: GetProcessOptions): TaskRunProcess {
    const processEnv = this.buildProcessEnvironment(taskRunEnv);

    const taskRunProcess = new TaskRunProcess({
      workerManifest: this.workerManifest,
      env: processEnv,
      serverWorker: {
        // Telemetry-only (becomes OTel worker.id). Prefer the plain friendlyId; fall back to
        // DEPLOYMENT_ID (which may be an opaque token) only when an older supervisor didn't set it.
        id: this.env.TRIGGER_DEPLOYMENT_FRIENDLY_ID ?? this.env.TRIGGER_DEPLOYMENT_ID,
        contentHash: this.env.TRIGGER_CONTENT_HASH,
        version: this.env.TRIGGER_DEPLOYMENT_VERSION,
        engine: "V2",
      },

      machineResources: {
        cpu: Number(this.env.TRIGGER_MACHINE_CPU),
        memory: Number(this.env.TRIGGER_MACHINE_MEMORY),
      },
      isWarmStart,
      // This runner's cgroup holds only the controller and the one task process it runs.
      oomKillCounter: OWN_CGROUP_OOM_KILL_COUNTER,
    }).initialize();

    return taskRunProcess;
  }

  private buildProcessEnvironment(taskRunEnv: Record<string, string>): Record<string, string> {
    return {
      ...forkEnvFromRunEnv(taskRunEnv),
      ...this.env.gatherProcessEnv(),
      TRIGGER_MACHINE_ID: this.machineId,
      HEARTBEAT_INTERVAL_MS: String(this.env.TRIGGER_HEARTBEAT_INTERVAL_SECONDS * 1000),
    };
  }

  private shouldReusePersistentProcess(): boolean {
    this.sendDebugLog("Checking if persistent process should be reused", {
      executionCount: this.executionCount,
      maxExecutionCount: this.processKeepAliveMaxExecutionCount,
      pid: this.persistentProcess?.pid ?? "unknown",
      isBeingKilled: this.persistentProcess?.isBeingKilled ?? "unknown",
    });

    return (
      !!this.persistentProcess &&
      this.executionCount < this.processKeepAliveMaxExecutionCount &&
      this.persistentProcess.isHealthy
    );
  }

  private shouldKeepProcessAlive(process: TaskRunProcess): boolean {
    return this.executionCount < this.processKeepAliveMaxExecutionCount && process.isHealthy;
  }

  private async cleanupProcess(taskRunProcess: TaskRunProcess): Promise<void> {
    if (taskRunProcess && taskRunProcess.pid !== undefined) {
      this.sendDebugLog("Cleaning up TaskRunProcess", { pid: taskRunProcess.pid });

      await taskRunProcess.kill("SIGKILL").catch(() => {});
    }
  }

  private sendDebugLog(message: string, properties?: SendDebugLogOptions["properties"]): void {
    this.logger.sendDebugLog({
      runId: undefined, // Provider doesn't have access to current run ID
      message: `[taskRunProcessProvider] ${message}`,
      properties,
    });
  }
}
