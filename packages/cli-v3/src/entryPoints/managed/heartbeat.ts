import { IntervalService } from "@trigger.dev/core/v3";
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
  private readonly heartbeat: IntervalService;

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

    this.heartbeat = new IntervalService({
      onInterval: async () => {
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
