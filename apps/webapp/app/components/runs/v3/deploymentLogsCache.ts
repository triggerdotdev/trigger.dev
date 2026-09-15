export type DeploymentLogEntry = {
  message: string;
  timestamp: Date;
  level: "info" | "error" | "warn" | "debug";
};

export type CachedDeploymentLogs = {
  logs: readonly DeploymentLogEntry[];
  nextSeqNum: number;
  finalized: boolean;
  complete: boolean;
};

export class DeploymentLogsCache {
  private entries = new Map<string, CachedDeploymentLogs>();
  private totalLines = 0;

  constructor(
    private readonly maxDeployments: number,
    private readonly maxTotalLines: number
  ) {}

  get(key: string): CachedDeploymentLogs | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, value: CachedDeploymentLogs) {
    const existing = this.entries.get(key);
    if (existing) {
      this.totalLines -= existing.logs.length;
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.totalLines += value.logs.length;

    for (const [oldestKey, oldest] of this.entries) {
      if (oldestKey === key) break;
      if (this.entries.size <= this.maxDeployments && this.totalLines <= this.maxTotalLines) break;
      this.entries.delete(oldestKey);
      this.totalLines -= oldest.logs.length;
    }
  }

  get size() {
    return this.entries.size;
  }

  get lineCount() {
    return this.totalLines;
  }
}

export const deploymentLogsCache = new DeploymentLogsCache(20, 20_000);
