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
  // Group processes by worker version
  private availableProcessesByVersion: Map<string, TaskRunProcess[]> = new Map();
  private busyProcessesByVersion: Map<string, Set<TaskRunProcess>> = new Map();
  private readonly options: TaskRunProcessPoolOptions;
  private readonly maxPoolSize: number;
  private readonly maxExecutionsPerProcess: number;
  private readonly executionCountsPerProcess: Map<number, number> = new Map();
  private readonly deprecatedVersions: Set<string> = new Set();

  constructor(options: TaskRunProcessPoolOptions) {
    this.options = options;
    this.maxPoolSize = options.maxPoolSize ?? 3;
    this.maxExecutionsPerProcess = options.maxExecutionsPerProcess ?? 50;
  }

  deprecateVersion(version: string) {
    this.deprecatedVersions.add(version);

    logger.debug("[TaskRunProcessPool] Deprecating version", { version });

    const versionProcesses = this.availableProcessesByVersion.get(version) || [];

    const processesToKill = versionProcesses.filter((process) => !process.isExecuting());
    Promise.all(processesToKill.map((process) => this.killProcess(process))).then(() => {
      this.availableProcessesByVersion.delete(version);
    });
  }

  async getProcess(
    workerManifest: WorkerManifest,
    serverWorker: ServerBackgroundWorker,
    machineResources: MachinePresetResources,
    env?: Record<string, string>
  ): Promise<{ taskRunProcess: TaskRunProcess; isReused: boolean }> {
    const version = serverWorker.version || "unknown";

    // Try to reuse an existing process if enabled
    if (this.options.enableProcessReuse) {
      const reusableProcess = this.findReusableProcess(version);
      if (reusableProcess) {
        const availableCount = this.availableProcessesByVersion.get(version)?.length || 0;
        const busyCount = this.busyProcessesByVersion.get(version)?.size || 0;

        logger.debug("[TaskRunProcessPool] Reusing existing process", {
          version,
          availableCount,
          busyCount,
        });

        // Remove from available and add to busy for this version
        const availableProcesses = this.availableProcessesByVersion.get(version) || [];
        this.availableProcessesByVersion.set(
          version,
          availableProcesses.filter((p) => p !== reusableProcess)
        );

        if (!this.busyProcessesByVersion.has(version)) {
          this.busyProcessesByVersion.set(version, new Set());
        }
        this.busyProcessesByVersion.get(version)!.add(reusableProcess);

        return { taskRunProcess: reusableProcess, isReused: true };
      } else {
        const availableCount = this.availableProcessesByVersion.get(version)?.length || 0;
        const busyCount = this.busyProcessesByVersion.get(version)?.size || 0;

        logger.debug("[TaskRunProcessPool] No reusable process found", {
          version,
          availableCount,
          busyCount,
        });
      }
    }

    // Create new process
    const availableCount = this.availableProcessesByVersion.get(version)?.length || 0;
    const busyCount = this.busyProcessesByVersion.get(version)?.size || 0;

    logger.debug("[TaskRunProcessPool] Creating new process", {
      version,
      availableCount,
      busyCount,
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

    // Add to busy processes for this version
    if (!this.busyProcessesByVersion.has(version)) {
      this.busyProcessesByVersion.set(version, new Set());
    }
    this.busyProcessesByVersion.get(version)!.add(newProcess);

    return { taskRunProcess: newProcess, isReused: false };
  }

  async returnProcess(process: TaskRunProcess, version: string): Promise<void> {
    // Remove from busy processes for this version
    const busyProcesses = this.busyProcessesByVersion.get(version);
    if (busyProcesses) {
      busyProcesses.delete(process);
    }

    if (process.pid) {
      this.executionCountsPerProcess.set(
        process.pid,
        (this.executionCountsPerProcess.get(process.pid) ?? 0) + 1
      );
    }

    if (this.shouldReuseProcess(process, version)) {
      const availableCount = this.availableProcessesByVersion.get(version)?.length || 0;
      const busyCount = this.busyProcessesByVersion.get(version)?.size || 0;

      logger.debug("[TaskRunProcessPool] Returning process to pool", {
        version,
        availableCount,
        busyCount,
      });

      // Clean up but don't kill the process
      try {
        await process.cleanup(false);

        // Add to available processes for this version
        if (!this.availableProcessesByVersion.has(version)) {
          this.availableProcessesByVersion.set(version, []);
        }
        this.availableProcessesByVersion.get(version)!.push(process);
      } catch (error) {
        logger.debug("[TaskRunProcessPool] Failed to cleanup process for reuse, killing it", {
          error,
        });
        await this.killProcess(process);
      }
    } else {
      const availableCount = this.availableProcessesByVersion.get(version)?.length || 0;
      const busyCount = this.busyProcessesByVersion.get(version)?.size || 0;

      logger.debug("[TaskRunProcessPool] Killing process", {
        version,
        availableCount,
        busyCount,
      });
      await this.killProcess(process);
    }
  }

  private findReusableProcess(version: string): TaskRunProcess | undefined {
    const availableProcesses = this.availableProcessesByVersion.get(version) || [];
    return availableProcesses.find((process) => this.isProcessHealthy(process));
  }

  private shouldReuseProcess(process: TaskRunProcess, version: string): boolean {
    const isHealthy = this.isProcessHealthy(process);
    const isBeingKilled = process.isBeingKilled;
    const pid = process.pid;
    const executionCount = this.executionCountsPerProcess.get(pid ?? 0) ?? 0;
    const availableCount = this.availableProcessesByVersion.get(version)?.length || 0;
    const busyCount = this.busyProcessesByVersion.get(version)?.size || 0;
    const isDeprecated = this.deprecatedVersions.has(version);

    logger.debug("[TaskRunProcessPool] Checking if process should be reused", {
      version,
      isHealthy,
      isBeingKilled,
      pid,
      availableCount,
      busyCount,
      maxPoolSize: this.maxPoolSize,
      executionCount,
      isDeprecated,
    });

    return (
      this.options.enableProcessReuse &&
      this.isProcessHealthy(process) &&
      availableCount < this.maxPoolSize &&
      executionCount < this.maxExecutionsPerProcess &&
      !isDeprecated
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
    const totalAvailable = Array.from(this.availableProcessesByVersion.values()).reduce(
      (sum, processes) => sum + processes.length,
      0
    );
    const totalBusy = Array.from(this.busyProcessesByVersion.values()).reduce(
      (sum, processes) => sum + processes.size,
      0
    );

    logger.debug("[TaskRunProcessPool] Shutting down pool", {
      availableCount: totalAvailable,
      busyCount: totalBusy,
      versions: Array.from(this.availableProcessesByVersion.keys()),
    });

    // Kill all available processes across all versions
    const allAvailableProcesses = Array.from(this.availableProcessesByVersion.values()).flat();
    await Promise.all(allAvailableProcesses.map((process) => this.killProcess(process)));
    this.availableProcessesByVersion.clear();

    // Kill all busy processes across all versions
    const allBusyProcesses = Array.from(this.busyProcessesByVersion.values())
      .map((processSet) => Array.from(processSet))
      .flat();
    await Promise.all(allBusyProcesses.map((process) => this.killProcess(process)));
    this.busyProcessesByVersion.clear();
  }

  getStats() {
    const totalAvailable = Array.from(this.availableProcessesByVersion.values()).reduce(
      (sum, processes) => sum + processes.length,
      0
    );
    const totalBusy = Array.from(this.busyProcessesByVersion.values()).reduce(
      (sum, processes) => sum + processes.size,
      0
    );

    const statsByVersion: Record<string, { available: number; busy: number }> = {};
    for (const [version, processes] of this.availableProcessesByVersion.entries()) {
      statsByVersion[version] = {
        available: processes.length,
        busy: this.busyProcessesByVersion.get(version)?.size || 0,
      };
    }
    for (const [version, processes] of this.busyProcessesByVersion.entries()) {
      if (!statsByVersion[version]) {
        statsByVersion[version] = {
          available: 0,
          busy: processes.size,
        };
      }
    }

    return {
      availableCount: totalAvailable,
      busyCount: totalBusy,
      totalCount: totalAvailable + totalBusy,
      byVersion: statsByVersion,
    };
  }
}
