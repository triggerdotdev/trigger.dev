import { WorkloadHttpClient } from "@trigger.dev/core/v3/runEngineWorker";
import { RunLogger } from "./logger.js";
import { HeartbeatService, RunExecutionData } from "@trigger.dev/core/v3";

export type RunExecutionSnapshotPollerOptions = {
  runFriendlyId: string;
  snapshotFriendlyId: string;
  httpClient: WorkloadHttpClient;
  logger: RunLogger;
  snapshotPollIntervalSeconds: number;
  handleSnapshotChange: (execution: RunExecutionData) => Promise<void>;
};

export class RunExecutionSnapshotPoller {
  private readonly logger: RunLogger;
  private readonly poller: HeartbeatService;
  private readonly httpClient: WorkloadHttpClient;

  private readonly runFriendlyId: string;
  private snapshotFriendlyId: string;

  private readonly snapshotPollIntervalSeconds: number;

  private readonly handleSnapshotChange: (execution: RunExecutionData) => Promise<void>;

  constructor(opts: RunExecutionSnapshotPollerOptions) {
    this.logger = opts.logger;
    this.httpClient = opts.httpClient;

    this.runFriendlyId = opts.runFriendlyId;
    this.snapshotFriendlyId = opts.snapshotFriendlyId;

    this.handleSnapshotChange = opts.handleSnapshotChange;

    this.poller = new HeartbeatService({
      heartbeat: async () => {
        if (!this.runFriendlyId) {
          this.logger.sendDebugLog({
            runId: this.runFriendlyId,
            message: "Skipping snapshot poll, no run ID",
          });
          return;
        }

        this.logger.sendDebugLog({
          runId: this.runFriendlyId,
          message: "Polling for latest snapshot",
        });

        this.logger.sendDebugLog({
          runId: this.runFriendlyId,
          message: `snapshot poll: started`,
          properties: {
            snapshotId: this.snapshotFriendlyId,
          },
        });

        const response = await this.httpClient.getRunExecutionData(this.runFriendlyId);

        if (!response.success) {
          this.logger.sendDebugLog({
            runId: this.runFriendlyId,
            message: "Snapshot poll failed",
            properties: {
              error: response.error,
            },
          });

          this.logger.sendDebugLog({
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
        this.logger.sendDebugLog({
          runId: this.runFriendlyId,
          message: "Failed to poll for snapshot",
          properties: { error: error instanceof Error ? error.message : String(error) },
        });
      },
    });
  }

  resetCurrentInterval() {
    this.poller.resetCurrentInterval();
  }

  updateSnapshotId(snapshotId: string) {
    this.snapshotFriendlyId = snapshotId;
  }

  updateInterval(intervalMs: number) {
    this.poller.updateInterval(intervalMs);
  }

  start() {
    this.poller.start();
  }

  stop() {
    this.poller.stop();
  }
}
