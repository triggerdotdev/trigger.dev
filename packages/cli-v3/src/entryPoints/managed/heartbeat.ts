import { HeartbeatService, RunExecutionData } from "@trigger.dev/core/v3";
import { WorkloadHttpClient } from "@trigger.dev/core/v3/runEngineWorker";
import { RunLogger } from "./logger.js";

export type RunExecutionHeartbeatOptions = {
  runFriendlyId: string;
  snapshotFriendlyId: string;
  httpClient: WorkloadHttpClient;
  logger: RunLogger;
  heartbeatIntervalSeconds: number;
};

export class RunExecutionHeartbeat {
  private readonly runFriendlyId: string;
  private snapshotFriendlyId: string;

  private readonly httpClient: WorkloadHttpClient;
  private readonly logger: RunLogger;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeat: HeartbeatService;

  constructor(opts: RunExecutionHeartbeatOptions) {
    this.runFriendlyId = opts.runFriendlyId;
    this.snapshotFriendlyId = opts.snapshotFriendlyId;
    this.httpClient = opts.httpClient;
    this.logger = opts.logger;
    this.heartbeatIntervalMs = opts.heartbeatIntervalSeconds * 1000;

    this.logger.sendDebugLog({
      runId: this.runFriendlyId,
      message: "RunExecutionHeartbeat",
      properties: {
        runFriendlyId: this.runFriendlyId,
        snapshotFriendlyId: this.snapshotFriendlyId,
        heartbeatIntervalSeconds: opts.heartbeatIntervalSeconds,
      },
    });

    this.heartbeat = new HeartbeatService({
      heartbeat: async () => {
        this.logger.sendDebugLog({
          runId: this.runFriendlyId,
          message: "heartbeat: started",
        });

        const response = await this.httpClient.heartbeatRun(
          this.runFriendlyId,
          this.snapshotFriendlyId
        );

        if (!response.success) {
          this.logger.sendDebugLog({
            runId: this.runFriendlyId,
            message: "heartbeat: failed",
            properties: {
              error: response.error,
            },
          });
        }
      },
      intervalMs: this.heartbeatIntervalMs,
      leadingEdge: false,
      onError: async (error) => {
        this.logger.sendDebugLog({
          runId: this.runFriendlyId,
          message: "Failed to send heartbeat",
          properties: { error: error instanceof Error ? error.message : String(error) },
        });
      },
    });
  }

  resetCurrentInterval() {
    this.heartbeat.resetCurrentInterval();
  }

  updateSnapshotId(snapshotFriendlyId: string) {
    this.snapshotFriendlyId = snapshotFriendlyId;
  }

  updateInterval(intervalMs: number) {
    this.heartbeat.updateInterval(intervalMs);
  }

  start() {
    this.heartbeat.start();
  }

  stop() {
    this.heartbeat.stop();
  }
}

type RunExecutionSnapshotPollerOptions = {
  runFriendlyId: string;
  snapshotFriendlyId: string;
  httpClient: WorkloadHttpClient;
  logger: RunLogger;
  snapshotPollIntervalSeconds: number;
  handleSnapshotChange: (execution: RunExecutionData) => Promise<void>;
};

class RunExecutionSnapshotPoller {
  private readonly logger: RunLogger;
  private readonly poller: HeartbeatService;
  private readonly httpClient: WorkloadHttpClient;

  private readonly runFriendlyId: string;
  private readonly snapshotFriendlyId: string;

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
      intervalMs: opts.snapshotPollIntervalSeconds * 1000,
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
