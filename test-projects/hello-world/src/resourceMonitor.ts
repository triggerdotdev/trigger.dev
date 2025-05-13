import { promisify } from "node:util";
import { exec } from "node:child_process";
import os from "node:os";
import { promises as fs } from "node:fs";
import { type Context, logger } from "@trigger.dev/sdk";

const execAsync = promisify(exec);

export type DiskMetrics = {
  total: number;
  used: number;
  free: number;
  percentUsed: number;
  warning?: string;
};

export type MemoryMetrics = {
  total: number;
  free: number;
  used: number;
  percentUsed: number;
};

export type NodeProcessMetrics = {
  memoryUsage: number;
  memoryUsagePercent: number;
};

export type TargetProcessMetrics = {
  method: string;
  processName: string;
  count: number;
  processes: ProcessInfo[];
  averages: {
    cpu: number;
    memory: number;
    rss: number;
    vsz: number;
  } | null;
  totals: {
    cpu: number;
    memory: number;
    rss: number;
    vsz: number;
  } | null;
};

export type ProcessMetrics = {
  node: NodeProcessMetrics;
  target: TargetProcessMetrics | null;
};

type ProcessInfo = {
  user: string;
  pid: number;
  cpu: number;
  mem: number;
  vsz: number;
  rss: number;
  command: string;
};

export type SystemMetrics = {
  disk: DiskMetrics;
  memory: MemoryMetrics;
};

export type ResourceMonitorConfig = {
  dirName?: string;
  processName?: string;
  ctx: Context;
};

// Constants
const DISK_LIMIT_GB = 10;
const DISK_LIMIT_BYTES = DISK_LIMIT_GB * 1024 * 1024 * 1024; // 10Gi in bytes

/**
 * Utility class for monitoring system resources and process metrics
 */
export class ResourceMonitor {
  private logInterval: NodeJS.Timeout | null = null;
  private logger: typeof logger;
  private dirName: string;
  private processName: string;
  private ctx: Context;

  constructor(config: ResourceMonitorConfig) {
    this.logger = logger;
    this.dirName = config.dirName ?? "/tmp";
    this.processName = config.processName ?? "node";
    this.ctx = config.ctx;
  }

  /**
   * Start periodic resource monitoring
   * @param intervalMs Monitoring interval in milliseconds
   */
  startMonitoring(intervalMs = 10000): void {
    if (intervalMs < 1000) {
      intervalMs = 1000;
      this.logger.warn("ResourceMonitor: intervalMs is less than 1000, setting to 1000");
    }

    if (this.logInterval) {
      clearInterval(this.logInterval);
    }

    this.logInterval = setInterval(this.logResources.bind(this), intervalMs);
  }

  /**
   * Stop resource monitoring
   */
  stopMonitoring(): void {
    if (this.logInterval) {
      clearInterval(this.logInterval);
      this.logInterval = null;
    }
  }

  private async logResources() {
    try {
      await this.logResourceSnapshot("RESOURCE_MONITOR");
    } catch (error) {
      this.logger.error(
        `Resource monitoring error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get combined system metrics (disk and memory)
   */
  private async getSystemMetrics(): Promise<SystemMetrics> {
    const [disk, memory] = await Promise.all([this.getDiskMetrics(), this.getMemoryMetrics()]);
    return { disk, memory };
  }

  /**
   * Get disk space information
   */
  private async getDiskMetrics(): Promise<DiskMetrics> {
    try {
      // Even with permission errors, du will output a total
      const { stdout, stderr } = await execAsync(`du -sb ${this.dirName} || true`);

      // Get the last line of stdout which contains the total
      const lastLine = stdout.split("\n").filter(Boolean).pop() || "";
      const usedBytes = parseInt(lastLine.split("\t")[0], 10);

      const effectiveTotal = DISK_LIMIT_BYTES;
      const effectiveUsed = Math.min(usedBytes, DISK_LIMIT_BYTES);
      const effectiveFree = effectiveTotal - effectiveUsed;
      const percentUsed = (effectiveUsed / effectiveTotal) * 100;

      const metrics: DiskMetrics = {
        total: effectiveTotal,
        used: effectiveUsed,
        free: effectiveFree,
        percentUsed,
      };

      // If we had permission errors, add a warning
      if (stderr.includes("Permission denied") || stderr.includes("cannot access")) {
        metrics.warning = "Some directories were not accessible";
      } else if (stderr.includes("No such file or directory")) {
        metrics.warning = "The directory does not exist";
      }

      return metrics;
    } catch (error) {
      this.logger.error(
        `Error getting disk metrics: ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        free: DISK_LIMIT_BYTES,
        total: DISK_LIMIT_BYTES,
        used: 0,
        percentUsed: 0,
        warning: "Failed to measure disk usage",
      };
    }
  }

  /**
   * Get memory metrics
   */
  private getMemoryMetrics(): MemoryMetrics {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const percentUsed = (used / total) * 100;

    return { total, free, used, percentUsed };
  }

  /**
   * Get process-specific metrics using /proc filesystem
   */
  private async getProcMetrics(pids: number[]): Promise<ProcessInfo[]> {
    return Promise.all(
      pids.map(async (pid) => {
        try {
          // Read process status
          const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
          const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
          const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");

          // Parse VmRSS (resident set size) from status
          const rss = parseInt(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? "0", 10);
          // Parse VmSize (virtual memory size) from status
          const vsz = parseInt(status.match(/VmSize:\s+(\d+)/)?.[1] ?? "0", 10);
          // Get process owner
          const user = (await fs.stat(`/proc/${pid}`)).uid.toString();

          // Parse CPU stats from /proc/[pid]/stat
          const stats = stat.split(" ");
          const utime = parseInt(stats[13], 10);
          const stime = parseInt(stats[14], 10);
          const starttime = parseInt(stats[21], 10);

          // Calculate CPU percentage
          const totalTime = utime + stime;
          const uptime = os.uptime();
          const hertz = 100; // Usually 100 on Linux
          const elapsedTime = uptime - starttime / hertz;
          const cpuUsage = 100 * (totalTime / hertz / elapsedTime);

          // Calculate memory percentage against total system memory
          const totalMem = os.totalmem();
          const memoryPercent = (rss * 1024 * 100) / totalMem;

          return {
            user,
            pid,
            cpu: cpuUsage,
            mem: memoryPercent,
            vsz,
            rss,
            command: cmdline.replace(/\0/g, " ").trim(),
          };
        } catch (error) {
          return null;
        }
      })
    ).then((results) => results.filter((r): r is ProcessInfo => r !== null));
  }

  /**
   * Find PIDs for a process name using /proc filesystem
   */
  private async findPidsByName(processName: string): Promise<number[]> {
    try {
      const pids: number[] = [];
      const procDirs = await fs.readdir("/proc");

      for (const dir of procDirs) {
        if (!/^\d+$/.test(dir)) continue;

        try {
          const cmdline = await fs.readFile(`/proc/${dir}/cmdline`, "utf8");
          if (cmdline.includes(processName)) {
            pids.push(parseInt(dir, 10));
          }
        } catch {
          // Ignore errors reading individual process info
          continue;
        }
      }

      return pids;
    } catch {
      return [];
    }
  }

  /**
   * Get process-specific metrics
   */
  private async getProcessMetrics(): Promise<ProcessMetrics> {
    // Get Node.js process metrics
    const totalMemory = os.totalmem();
    // Convert GB to bytes (machine.memory is in GB)
    const machineMemoryBytes = this.ctx.machine
      ? this.ctx.machine.memory * 1024 * 1024 * 1024
      : totalMemory;
    const nodeMemoryUsage = process.memoryUsage().rss;

    // Node process percentage is based on machine memory if available, otherwise system memory
    const nodeMemoryPercent = (nodeMemoryUsage / machineMemoryBytes) * 100;

    const nodeMetrics: NodeProcessMetrics = {
      memoryUsage: nodeMemoryUsage,
      memoryUsagePercent: nodeMemoryPercent,
    };

    let method = "ps";

    try {
      let processes: ProcessInfo[] = [];

      // Try ps first, fall back to /proc if it fails
      try {
        const { stdout: psOutput } = await execAsync(
          `ps aux | grep ${this.processName} | grep -v grep`
        );

        if (psOutput.trim()) {
          processes = psOutput
            .trim()
            .split("\n")
            .map((line) => {
              const parts = line.trim().split(/\s+/);
              return {
                user: parts[0],
                pid: parseInt(parts[1], 10),
                cpu: parseFloat(parts[2]),
                mem: parseFloat(parts[3]),
                vsz: parseInt(parts[4], 10),
                rss: parseInt(parts[5], 10),
                command: parts.slice(10).join(" "),
              };
            });
        }
      } catch {
        // ps failed, try /proc instead
        method = "proc";
        const pids = await this.findPidsByName(this.processName);
        processes = await this.getProcMetrics(pids);
      }

      if (processes.length === 0) {
        return {
          node: nodeMetrics,
          target: {
            method,
            processName: this.processName,
            count: 0,
            processes: [],
            averages: null,
            totals: null,
          },
        };
      }

      // For CPU:
      // - ps shows CPU percentage per core (e.g., 100% = 1 core)
      // - machine.cpu is in cores (e.g., 0.5 = half a core)
      // - we want to show percentage of allocated CPU (e.g., 100% = using all allocated CPU)
      const availableCpu = this.ctx.machine?.cpu ?? os.cpus().length;
      const cpuNormalizer = availableCpu * 100; // Convert to basis points for better precision with fractional CPUs

      // For Memory:
      // - ps 'mem' is already a percentage of system memory
      // - we need to convert it to a percentage of machine memory
      // - if machine memory is 0.5GB and system has 16GB, we multiply the percentage by 32
      const memoryScaleFactor = this.ctx.machine ? totalMemory / machineMemoryBytes : 1;

      const totals = processes.reduce(
        (acc, proc) => ({
          cpu: acc.cpu + proc.cpu,
          // Scale memory percentage to machine memory
          // TODO: test this
          memory: acc.memory + proc.mem * memoryScaleFactor,
          rss: acc.rss + proc.rss,
          vsz: acc.vsz + proc.vsz,
        }),
        { cpu: 0, memory: 0, rss: 0, vsz: 0 }
      );

      const count = processes.length;

      const averages = {
        cpu: totals.cpu / (count * cpuNormalizer),
        memory: totals.memory / count,
        rss: totals.rss / count,
        vsz: totals.vsz / count,
      };

      return {
        node: nodeMetrics,
        target: {
          method,
          processName: this.processName,
          count,
          processes,
          averages,
          totals: {
            cpu: totals.cpu / cpuNormalizer,
            memory: totals.memory,
            rss: totals.rss,
            vsz: totals.vsz,
          },
        },
      };
    } catch (error) {
      return {
        node: nodeMetrics,
        target: {
          method,
          processName: this.processName,
          count: 0,
          processes: [],
          averages: null,
          totals: null,
        },
      };
    }
  }

  /**
   * Log a snapshot of current resource usage
   */
  async logResourceSnapshot(label = "Resource Snapshot"): Promise<void> {
    try {
      const [systemMetrics, processMetrics] = await Promise.all([
        this.getSystemMetrics(),
        this.getProcessMetrics(),
      ]);

      const formatBytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);
      const formatPercent = (value: number) => value.toFixed(1);

      this.logger.info(label, {
        system: {
          disk: {
            limitGiB: DISK_LIMIT_GB,
            dirName: this.dirName,
            usedGiB: (systemMetrics.disk.used / (1024 * 1024 * 1024)).toFixed(2),
            freeGiB: (systemMetrics.disk.free / (1024 * 1024 * 1024)).toFixed(2),
            percentUsed: formatPercent(systemMetrics.disk.percentUsed),
            warning: systemMetrics.disk.warning,
          },
          memory: {
            freeGB: (systemMetrics.memory.free / (1024 * 1024 * 1024)).toFixed(2),
            percentUsed: formatPercent(systemMetrics.memory.percentUsed),
          },
        },
        constraints: this.ctx.machine
          ? {
              cpu: this.ctx.machine.cpu,
              memoryGB: this.ctx.machine.memory,
              diskGB: DISK_LIMIT_BYTES / (1024 * 1024 * 1024),
            }
          : {
              cpu: os.cpus().length,
              memoryGB: Math.floor(os.totalmem() / (1024 * 1024 * 1024)),
              note: "Using system resources (no machine constraints specified)",
            },
        process: {
          node: {
            memoryUsageMB: formatBytes(processMetrics.node.memoryUsage),
            memoryUsagePercent: formatPercent(processMetrics.node.memoryUsagePercent),
          },
          target: processMetrics.target
            ? {
                method: processMetrics.target.method,
                processName: processMetrics.target.processName,
                count: processMetrics.target.count,
                averages: processMetrics.target.averages
                  ? {
                      cpuPercent: formatPercent(processMetrics.target.averages.cpu * 100),
                      memoryPercent: formatPercent(processMetrics.target.averages.memory),
                      rssMB: formatBytes(processMetrics.target.averages.rss * 1024),
                      vszMB: formatBytes(processMetrics.target.averages.vsz * 1024),
                    }
                  : null,
                totals: processMetrics.target.totals
                  ? {
                      cpuPercent: formatPercent(processMetrics.target.totals.cpu * 100),
                      memoryPercent: formatPercent(processMetrics.target.totals.memory),
                      rssMB: formatBytes(processMetrics.target.totals.rss * 1024),
                      vszMB: formatBytes(processMetrics.target.totals.vsz * 1024),
                    }
                  : null,
              }
            : null,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error(
        `Error logging resource snapshot: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
