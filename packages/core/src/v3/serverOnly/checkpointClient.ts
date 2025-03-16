import { SupervisorHttpClient } from "../runEngineWorker/index.js";
import {
  CheckpointServiceSuspendRequestBodyInput,
  CheckpointServiceSuspendResponseBody,
  CheckpointServiceRestoreRequestBodyInput,
} from "../schemas/checkpoints.js";
import { DequeuedMessage } from "../schemas/runEngine.js";
import { SimpleStructuredLogger } from "../utils/structuredLogger.js";

export type CheckpointClientOptions = {
  apiUrl: URL;
  workerClient: SupervisorHttpClient;
};

export class CheckpointClient {
  private readonly logger = new SimpleStructuredLogger("checkpoint-client");
  private readonly apiUrl: URL;
  private readonly workerClient: SupervisorHttpClient;

  private get restoreUrl() {
    return new URL("/api/v1/restore", this.apiUrl);
  }

  private get suspendUrl() {
    return new URL("/api/v1/suspend", this.apiUrl);
  }

  constructor(opts: CheckpointClientOptions) {
    this.apiUrl = opts.apiUrl;
    this.workerClient = opts.workerClient;
  }

  async suspendRun({
    runFriendlyId,
    snapshotFriendlyId,
    containerId,
    runnerId,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    containerId: string;
    runnerId: string;
  }): Promise<boolean> {
    const completionUrl = this.workerClient.getSuspendCompletionUrl(
      runFriendlyId,
      snapshotFriendlyId,
      runnerId
    );

    const res = await fetch(this.suspendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "DOCKER",
        containerId,
        callbacks: {
          completion: completionUrl.url,
          headers: completionUrl.headers,
        },
      } satisfies CheckpointServiceSuspendRequestBodyInput),
    });

    if (!res.ok) {
      this.logger.error("[CheckpointClient] Suspend request failed", {
        runFriendlyId,
        snapshotFriendlyId,
        containerId,
      });
      return false;
    }

    this.logger.debug("[CheckpointClient] Suspend request success", {
      runFriendlyId,
      snapshotFriendlyId,
      containerId,
      status: res.status,
      contentType: res.headers.get("content-type"),
    });

    try {
      const data = await res.json();
      const parsedData = CheckpointServiceSuspendResponseBody.safeParse(data);

      if (!parsedData.success) {
        this.logger.error("[CheckpointClient] Suspend response invalid", {
          runFriendlyId,
          snapshotFriendlyId,
          containerId,
          data,
        });
        return false;
      }
    } catch (error) {
      this.logger.error("[CheckpointClient] Suspend response error", {
        error,
        text: await res.text(),
      });
      return false;
    }

    return true;
  }

  async restoreRun({
    runFriendlyId,
    snapshotFriendlyId,
    checkpoint,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    checkpoint: NonNullable<DequeuedMessage["checkpoint"]>;
  }): Promise<boolean> {
    const res = await fetch(this.restoreUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "DOCKER",
        containerId: checkpoint.location,
      } satisfies CheckpointServiceRestoreRequestBodyInput),
    });

    if (!res.ok) {
      this.logger.error("[CheckpointClient] Restore request failed", {
        runFriendlyId,
        snapshotFriendlyId,
        checkpoint,
      });
      return false;
    }

    return true;
  }
}
