import { RunLogger, SendDebugLogOptions } from "./logger.js";
import { IntervalService } from "@trigger.dev/core/v3";

type OnPoll = (source: string) => Promise<void>;

export type RunExecutionSnapshotPollerOptions = {
  runFriendlyId: string;
  snapshotFriendlyId: string;
  logger: RunLogger;
  snapshotPollIntervalSeconds: number;
  onPoll: OnPoll;
};

export class RunExecutionSnapshotPoller {
  private runFriendlyId: string;
  private snapshotFriendlyId: string;
  private enabled: boolean;

  private readonly logger: RunLogger;
  private readonly onPoll: OnPoll;
  private readonly poller: IntervalService;

  private lastPollAt: Date | null = null;
  private pollCount = 0;

  constructor(opts: RunExecutionSnapshotPollerOptions) {
    this.enabled = false;

    this.runFriendlyId = opts.runFriendlyId;
    this.snapshotFriendlyId = opts.snapshotFriendlyId;
    this.logger = opts.logger;
    this.onPoll = opts.onPoll;

    const intervalMs = opts.snapshotPollIntervalSeconds * 1000;

    this.poller = new IntervalService({
      onInterval: async () => {
        if (!this.enabled) {
          this.sendDebugLog("poller disabled, skipping snapshot change handler (pre)");
          return;
        }

        this.sendDebugLog("polling for latest snapshot");

        this.lastPollAt = new Date();
        this.pollCount++;

        await this.onPoll("poller");
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

  get metrics() {
    return {
      lastPollAt: this.lastPollAt,
      pollCount: this.pollCount,
    };
  }

  private sendDebugLog(message: string, properties?: SendDebugLogOptions["properties"]) {
    this.logger.sendDebugLog({
      runId: this.runFriendlyId,
      message: `[poller] ${message}`,
      properties: {
        ...properties,
        ...this.metrics,
        snapshotId: this.snapshotFriendlyId,
        pollIntervalMs: this.poller.intervalMs,
      },
    });
  }
}
