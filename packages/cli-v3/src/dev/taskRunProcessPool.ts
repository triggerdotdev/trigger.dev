import {
  MachinePresetResources,
  ServerBackgroundWorker,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import { TaskRunProcess } from "../executions/taskRunProcess.js";
import { logger } from "../utilities/logger.js";

export type TaskRunProcessPoolOptions = {
  env: Record<string, string>;
  cwd: string;
  enableProcessReuse: boolean;
  maxPoolSize?: number;
  maxExecutionsPerProcess?: number;
};

export class TaskRunProcessPool {
  private availableProcesses: TaskRunProcess[] = [];
  private busyProcesses: Set<TaskRunProcess> = new Set();
  private readonly options: TaskRunProcessPoolOptions;
  private readonly maxPoolSize: number;
  private readonly maxExecutionsPerProcess: number;

  constructor(options: TaskRunProcessPoolOptions) {
    this.options = options;
    this.maxPoolSize = options.maxPoolSize ?? 3;
    this.maxExecutionsPerProcess = options.maxExecutionsPerProcess ?? 50;
  }

  async getProcess(
    workerManifest: WorkerManifest,
    serverWorker: ServerBackgroundWorker,
    machineResources: MachinePresetResources,
    env?: Record<string, string>
  ): Promise<{ taskRunProcess: TaskRunProcess; isReused: boolean }> {
    // Try to reuse an existing process if enabled
    if (this.options.enableProcessReuse) {
      const reusableProcess = this.findReusableProcess();
      if (reusableProcess) {
        logger.debug("[TaskRunProcessPool] Reusing existing process", {
          availableCount: this.availableProcesses.length,
          busyCount: this.busyProcesses.size,
        });

        this.availableProcesses = this.availableProcesses.filter((p) => p !== reusableProcess);
        this.busyProcesses.add(reusableProcess);
        return { taskRunProcess: reusableProcess, isReused: true };
      } else {
        logger.debug("[TaskRunProcessPool] No reusable process found", {
          availableCount: this.availableProcesses.length,
          busyCount: this.busyProcesses.size,
        });
      }
    }

    // Create new process
    logger.debug("[TaskRunProcessPool] Creating new process", {
      availableCount: this.availableProcesses.length,
      busyCount: this.busyProcesses.size,
    });

    const newProcess = new TaskRunProcess({
      workerManifest,
      env: {
        ...this.options.env,
        ...env,
      },
      serverWorker,
      machineResources,
      cwd: this.options.cwd,
    }).initialize();

    this.busyProcesses.add(newProcess);
    return { taskRunProcess: newProcess, isReused: false };
  }

  async returnProcess(process: TaskRunProcess): Promise<void> {
    this.busyProcesses.delete(process);

    if (this.shouldReuseProcess(process)) {
      logger.debug("[TaskRunProcessPool] Returning process to pool", {
        availableCount: this.availableProcesses.length,
        busyCount: this.busyProcesses.size,
      });

      // Clean up but don't kill the process
      try {
        await process.cleanup(false);
        this.availableProcesses.push(process);
      } catch (error) {
        logger.debug("[TaskRunProcessPool] Failed to cleanup process for reuse, killing it", {
          error,
        });
        await this.killProcess(process);
      }
    } else {
      logger.debug("[TaskRunProcessPool] Killing process", {
        availableCount: this.availableProcesses.length,
        busyCount: this.busyProcesses.size,
      });
      await this.killProcess(process);
    }
  }

  private findReusableProcess(): TaskRunProcess | undefined {
    return this.availableProcesses.find((process) => this.isProcessHealthy(process));
  }

  private shouldReuseProcess(process: TaskRunProcess): boolean {
    const isHealthy = this.isProcessHealthy(process);
    const isBeingKilled = process.isBeingKilled;
    const pid = process.pid;

    logger.debug("[TaskRunProcessPool] Checking if process should be reused", {
      isHealthy,
      isBeingKilled,
      pid,
      availableCount: this.availableProcesses.length,
      busyCount: this.busyProcesses.size,
      maxPoolSize: this.maxPoolSize,
    });

    return (
      this.options.enableProcessReuse &&
      this.isProcessHealthy(process) &&
      this.availableProcesses.length < this.maxPoolSize
    );
  }

  private isProcessHealthy(process: TaskRunProcess): boolean {
    // Basic health checks - we can expand this later
    return !process.isBeingKilled && process.pid !== undefined;
  }

  private async killProcess(process: TaskRunProcess): Promise<void> {
    try {
      await process.cleanup(true);
    } catch (error) {
      logger.debug("[TaskRunProcessPool] Error killing process", { error });
    }
  }

  async shutdown(): Promise<void> {
    logger.debug("[TaskRunProcessPool] Shutting down pool", {
      availableCount: this.availableProcesses.length,
      busyCount: this.busyProcesses.size,
    });

    // Kill all available processes
    await Promise.all(this.availableProcesses.map((process) => this.killProcess(process)));
    this.availableProcesses = [];

    // Kill all busy processes
    await Promise.all(Array.from(this.busyProcesses).map((process) => this.killProcess(process)));
    this.busyProcesses.clear();
  }

  getStats() {
    return {
      availableCount: this.availableProcesses.length,
      busyCount: this.busyProcesses.size,
      totalCount: this.availableProcesses.length + this.busyProcesses.size,
    };
  }
}
