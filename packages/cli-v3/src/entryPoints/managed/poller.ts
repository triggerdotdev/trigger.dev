import { WorkloadHttpClient } from "@trigger.dev/core/v3/runEngineWorker";
import { RunLogger, SendDebugLogOptions } from "./logger.js";
import { IntervalService, RunExecutionData } from "@trigger.dev/core/v3";

export type RunExecutionSnapshotPollerOptions = {
  runFriendlyId: string;
  snapshotFriendlyId: string;
  httpClient: WorkloadHttpClient;
  logger: RunLogger;
  snapshotPollIntervalSeconds: number;
  handleSnapshotChange: (execution: RunExecutionData) => Promise<void>;
};

export class RunExecutionSnapshotPoller {
  private runFriendlyId: string;
  private snapshotFriendlyId: string;
  private enabled: boolean;

  private readonly httpClient: WorkloadHttpClient;
  private readonly logger: RunLogger;
  private readonly handleSnapshotChange: (runData: RunExecutionData) => Promise<void>;
  private readonly poller: IntervalService;

  constructor(opts: RunExecutionSnapshotPollerOptions) {
    this.enabled = false;

    this.runFriendlyId = opts.runFriendlyId;
    this.snapshotFriendlyId = opts.snapshotFriendlyId;
    this.httpClient = opts.httpClient;
    this.logger = opts.logger;
    this.handleSnapshotChange = opts.handleSnapshotChange;

    const intervalMs = opts.snapshotPollIntervalSeconds * 1000;

    this.poller = new IntervalService({
      onInterval: async () => {
        if (!this.enabled) {
          this.sendDebugLog("poller disabled, skipping snapshot change handler (pre)");
          return;
        }

        this.sendDebugLog("polling for latest snapshot");

        const response = await this.httpClient.getRunExecutionData(this.runFriendlyId);

        if (!response.success) {
          this.sendDebugLog("failed to get run execution data", { error: response.error });
          return;
        }

        if (!this.enabled) {
          this.sendDebugLog("poller disabled, skipping snapshot change handler (post)");
          return;
        }

        await this.handleSnapshotChange(response.data.execution);
      },
      intervalMs,
      leadingEdge: false,
      onError: async (error) => {
        this.sendDebugLog("failed to poll for snapshot", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  private sendDebugLog(message: string, properties?: SendDebugLogOptions["properties"]) {
    this.logger.sendDebugLog({
      runId: this.runFriendlyId,
      message: `[poller] ${message}`,
      properties: {
        ...properties,
        runId: this.runFriendlyId,
        snapshotId: this.snapshotFriendlyId,
        pollIntervalMs: this.poller.intervalMs,
      },
    });
  }

  resetCurrentInterval() {
    this.poller.resetCurrentInterval();
  }

  // The snapshot ID is only used as an indicator of when a poller got stuck
  updateSnapshotId(snapshotFriendlyId: string) {
    this.snapshotFriendlyId = snapshotFriendlyId;
  }

  updateInterval(intervalMs: number) {
    this.poller.updateInterval(intervalMs);
  }

  start(): RunExecutionSnapshotPoller {
    if (this.enabled) {
      this.sendDebugLog("already started");
      return this;
    }

    this.sendDebugLog("start");

    this.enabled = true;
    this.poller.start();

    return this;
  }

  stop() {
    if (!this.enabled) {
      this.sendDebugLog("already stopped");
      return;
    }

    this.sendDebugLog("stop");

    this.enabled = false;

    const { isExecuting } = this.poller.stop();

    if (isExecuting) {
      this.sendDebugLog("stopped while executing");
    }
  }
}
