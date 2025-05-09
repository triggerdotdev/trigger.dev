import { tryCatch } from "@trigger.dev/core/utils";
import { RunLogger, SendDebugLogOptions } from "./logger.js";
import { TaskRunExecutionStatus, type RunExecutionData } from "@trigger.dev/core/v3";
import { assertExhaustive } from "@trigger.dev/core/utils";
import { MetadataClient } from "./overrides.js";

export type SnapshotState = {
  id: string;
  status: TaskRunExecutionStatus;
};

type SnapshotHandler = (runData: RunExecutionData, deprecated: boolean) => Promise<void>;
type SuspendableHandler = (suspendableSnapshot: SnapshotState) => Promise<void>;

type SnapshotManagerOptions = {
  runFriendlyId: string;
  runnerId: string;
  initialSnapshotId: string;
  initialStatus: TaskRunExecutionStatus;
  logger: RunLogger;
  metadataClient?: MetadataClient;
  onSnapshotChange: SnapshotHandler;
  onSuspendable: SuspendableHandler;
};

type QueuedChange =
  | { id: string; type: "snapshot"; snapshots: RunExecutionData[] }
  | { id: string; type: "suspendable"; value: boolean };

type QueuedChangeItem = {
  change: QueuedChange;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class SnapshotManager {
  private runFriendlyId: string;
  private runnerId: string;

  private logger: RunLogger;
  private metadataClient?: MetadataClient;

  private state: SnapshotState;
  private isSuspendable: boolean = false;

  private readonly onSnapshotChange: SnapshotHandler;
  private readonly onSuspendable: SuspendableHandler;

  private changeQueue: QueuedChangeItem[] = [];
  private isProcessingQueue = false;

  constructor(opts: SnapshotManagerOptions) {
    this.runFriendlyId = opts.runFriendlyId;
    this.runnerId = opts.runnerId;

    this.logger = opts.logger;
    this.metadataClient = opts.metadataClient;

    this.state = {
      id: opts.initialSnapshotId,
      status: opts.initialStatus,
    };

    this.onSnapshotChange = opts.onSnapshotChange;
    this.onSuspendable = opts.onSuspendable;
  }

  public get snapshotId(): string {
    return this.state.id;
  }

  public get status(): TaskRunExecutionStatus {
    return this.state.status;
  }

  public get suspendable(): boolean {
    return this.isSuspendable;
  }

  public async setSuspendable(suspendable: boolean): Promise<void> {
    if (this.isSuspendable === suspendable) {
      this.sendDebugLog(`skipping suspendable update, already ${suspendable}`);
      return;
    }

    this.sendDebugLog(`setting suspendable to ${suspendable}`);

    return this.enqueueSnapshotChange({
      id: crypto.randomUUID(),
      type: "suspendable",
      value: suspendable,
    });
  }

  /**
   * Update the snapshot ID and status without invoking any handlers
   *
   * @param snapshotId - The ID of the snapshot to update to
   * @param status - The status to update to
   */
  public updateSnapshot(snapshotId: string, status: TaskRunExecutionStatus) {
    // Check if this is an old snapshot
    if (snapshotId < this.state.id) {
      this.sendDebugLog("skipping update for old snapshot", {
        incomingId: snapshotId,
        currentId: this.state.id,
      });
      return;
    }

    this.state = { id: snapshotId, status };
  }

  public async handleSnapshotChanges(snapshots: RunExecutionData[]): Promise<void> {
    if (!this.statusCheck(snapshots)) {
      return;
    }

    return this.enqueueSnapshotChange({
      id: crypto.randomUUID(),
      type: "snapshot",
      snapshots,
    });
  }

  public get queueLength(): number {
    return this.changeQueue.length;
  }

  private statusCheck(snapshots: RunExecutionData[]): boolean {
    const latestSnapshot = snapshots[snapshots.length - 1];

    if (!latestSnapshot) {
      this.sendDebugLog("skipping status check for empty snapshots", {
        snapshots,
      });
      return false;
    }

    const { run, snapshot } = latestSnapshot;

    const statusCheckData = {
      incomingId: snapshot.friendlyId,
      incomingStatus: snapshot.executionStatus,
      currentId: this.state.id,
      currentStatus: this.state.status,
    };

    // Ensure run ID matches
    if (run.friendlyId !== this.runFriendlyId) {
      this.sendDebugLog("skipping update for mismatched run ID", {
        statusCheckData,
      });

      return false;
    }

    // Skip if this is an old snapshot
    if (snapshot.friendlyId < this.state.id) {
      this.sendDebugLog("skipping update for old snapshot", {
        statusCheckData,
      });

      return false;
    }

    // Skip if this is the current snapshot
    if (snapshot.friendlyId === this.state.id) {
      // DO NOT REMOVE (very noisy, but helpful for debugging)
      // this.sendDebugLog("skipping update for duplicate snapshot", {
      //   statusCheckData,
      // });

      return false;
    }

    return true;
  }

  private async enqueueSnapshotChange(change: QueuedChange): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // For suspendable changes, resolve and remove any pending suspendable changes since only the last one matters
      if (change.type === "suspendable") {
        const pendingSuspendable = this.changeQueue.filter(
          (item) => item.change.type === "suspendable"
        );

        // Resolve any pending suspendable changes - they're effectively done since we're superseding them
        for (const item of pendingSuspendable) {
          item.resolve();
        }

        // Remove the exact items we just resolved
        const resolvedIds = new Set(pendingSuspendable.map((item) => item.change.id));
        this.changeQueue = this.changeQueue.filter((item) => !resolvedIds.has(item.change.id));
      }

      this.changeQueue.push({ change, resolve, reject });

      // Sort queue:
      // 1. Suspendable changes always go to the back
      // 2. Snapshot changes are ordered by creation time, with the latest snapshot last
      this.changeQueue.sort((a, b) => {
        if (a.change.type === "suspendable" && b.change.type === "snapshot") {
          return 1; // a goes after b
        }
        if (a.change.type === "snapshot" && b.change.type === "suspendable") {
          return -1; // a goes before b
        }
        if (a.change.type === "snapshot" && b.change.type === "snapshot") {
          const snapshotA = a.change.snapshots[a.change.snapshots.length - 1];
          const snapshotB = b.change.snapshots[b.change.snapshots.length - 1];

          if (!snapshotA || !snapshotB) {
            return 0;
          }

          // Sort snapshot changes by creation time, old -> new
          return snapshotA.snapshot.createdAt.getTime() - snapshotB.snapshot.createdAt.getTime();
        }
        return 0; // both suspendable, maintain insertion order
      });

      // Start processing if not already running
      this.processQueue().catch((error) => {
        this.sendDebugLog("error processing queue", { error: error.message });
      });
    });
  }

  private async processQueue() {
    if (this.isProcessingQueue) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.queueLength > 0) {
        // Remove first item from queue
        const item = this.changeQueue.shift();
        if (!item) {
          break;
        }

        const [error] = await tryCatch(this.applyChange(item.change));

        // Resolve/reject promise
        if (error) {
          item.reject(error);
        } else {
          item.resolve();
        }
      }
    } finally {
      const hasMoreItems = this.queueLength > 0;
      this.isProcessingQueue = false;

      if (hasMoreItems) {
        this.processQueue().catch((error) => {
          this.sendDebugLog("error processing queue (finally)", { error: error.message });
        });
      }
    }
  }

  private async applyChange(change: QueuedChange): Promise<void> {
    switch (change.type) {
      case "snapshot": {
        const { snapshots } = change;

        // Double check we should process this snapshot
        if (!this.statusCheck(snapshots)) {
          return;
        }

        const latestSnapshot = change.snapshots[change.snapshots.length - 1];
        if (!latestSnapshot) {
          return;
        }

        // These are the snapshots between the current and the latest one
        const previousSnapshots = snapshots.slice(0, -1);

        // Check if any previous snapshot is QUEUED or SUSPENDED
        const deprecatedStatus: TaskRunExecutionStatus[] = ["QUEUED", "SUSPENDED"];
        const deprecatedSnapshots = previousSnapshots.filter((snap) =>
          deprecatedStatus.includes(snap.snapshot.executionStatus)
        );

        let deprecated = false;
        if (deprecatedSnapshots.length > 0) {
          const hasBeenRestored = await this.hasBeenRestored();

          if (hasBeenRestored) {
            // It's normal for a restored run to have deprecation markers, e.g. it will have been SUSPENDED
            deprecated = false;
          } else {
            deprecated = true;
          }
        }

        const { snapshot } = latestSnapshot;
        const oldState = { ...this.state };

        this.updateSnapshot(snapshot.friendlyId, snapshot.executionStatus);

        this.sendDebugLog(`status changed to ${snapshot.executionStatus}`, {
          oldId: oldState.id,
          newId: snapshot.friendlyId,
          oldStatus: oldState.status,
          newStatus: snapshot.executionStatus,
          deprecated,
        });

        // Execute handler
        await this.onSnapshotChange(latestSnapshot, deprecated);

        // Check suspendable state after snapshot change
        await this.checkSuspendableState();
        break;
      }
      case "suspendable": {
        this.isSuspendable = change.value;

        // Check suspendable state after suspendable change
        await this.checkSuspendableState();
        break;
      }
      default: {
        assertExhaustive(change);
      }
    }
  }

  private async hasBeenRestored() {
    if (!this.metadataClient) {
      return false;
    }

    const [error, overrides] = await this.metadataClient.getEnvOverrides();

    if (error) {
      return false;
    }

    if (!overrides.TRIGGER_RUNNER_ID) {
      return false;
    }

    if (overrides.TRIGGER_RUNNER_ID === this.runnerId) {
      return false;
    }

    this.runnerId = overrides.TRIGGER_RUNNER_ID;

    return true;
  }

  private async checkSuspendableState() {
    if (
      this.isSuspendable &&
      (this.state.status === "EXECUTING_WITH_WAITPOINTS" ||
        this.state.status === "QUEUED_EXECUTING")
    ) {
      // DO NOT REMOVE (very noisy, but helpful for debugging)
      // this.sendDebugLog("run is now suspendable, executing handler");
      await this.onSuspendable(this.state);
    }
  }

  public stop() {
    this.sendDebugLog("stop");

    // Clear any pending changes
    for (const item of this.changeQueue) {
      item.reject(new Error("SnapshotManager stopped"));
    }
    this.changeQueue = [];
  }

  protected sendDebugLog(message: string, properties?: SendDebugLogOptions["properties"]) {
    this.logger.sendDebugLog({
      runId: this.runFriendlyId,
      message: `[snapshot] ${message}`,
      properties: {
        ...properties,
        snapshotId: this.state.id,
        status: this.state.status,
        suspendable: this.isSuspendable,
        queueLength: this.queueLength,
        isProcessingQueue: this.isProcessingQueue,
      },
    });
  }
}
