import type { SupervisorHttpClient } from "../runEngineWorker/index.js";
import type {
  CheckpointServiceRestoreRequestBodyInput,
  CheckpointServiceSuspendRequestBodyInput,
} from "../schemas/checkpoints.js";
import { CheckpointServiceSuspendResponseBody } from "../schemas/checkpoints.js";
import type { CheckpointType } from "../schemas/runEngine.js";
import { SimpleStructuredLogger } from "../utils/structuredLogger.js";

export type CheckpointClientOptions = {
  apiUrl: URL;
  workerClient: SupervisorHttpClient;
  orchestrator: CheckpointType;
};

const CANCEL_TIMEOUT_MS = 5_000;

export class CheckpointClient {
  private readonly logger = new SimpleStructuredLogger("checkpoint-client");

  constructor(private readonly opts: CheckpointClientOptions) {}

  async suspendRun({
    runFriendlyId,
    snapshotFriendlyId,
    body,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    body: Omit<CheckpointServiceSuspendRequestBodyInput, "type">;
  }): Promise<boolean> {
    const res = await fetch(
      new URL(
        `/api/v1/runs/${runFriendlyId}/snapshots/${snapshotFriendlyId}/suspend`,
        this.opts.apiUrl
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: this.opts.orchestrator,
          ...body,
        } satisfies CheckpointServiceSuspendRequestBodyInput),
      }
    );

    if (!res.ok) {
      this.logger.error("[CheckpointClient] Suspend request failed", {
        runFriendlyId,
        snapshotFriendlyId,
        body,
      });
      return false;
    }

    this.logger.debug("[CheckpointClient] Suspend request success", {
      runFriendlyId,
      snapshotFriendlyId,
      body,
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
          body,
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
    body,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    body: CheckpointServiceRestoreRequestBodyInput;
  }): Promise<boolean> {
    const res = await fetch(
      new URL(
        `/api/v1/runs/${runFriendlyId}/snapshots/${snapshotFriendlyId}/restore`,
        this.opts.apiUrl
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      this.logger.error("[CheckpointClient] Restore request failed", {
        runFriendlyId,
        snapshotFriendlyId,
        body,
      });
      return false;
    }

    return true;
  }

  /**
   * Ask the checkpoint service to reclaim a finished run's checkpoint storage. Best-effort: the
   * service enqueues and returns 202, so a `true` here means accepted, not deleted.
   */
  async deleteCheckpoints({
    runFriendlyId,
    body,
  }: {
    runFriendlyId: string;
    body: {
      orgId: string;
      envId: string;
      projectRef: string;
      deploymentVersion: string;
    };
  }): Promise<boolean> {
    const res = await fetch(
      new URL(`/api/v1/runs/${runFriendlyId}/checkpoints/delete`, this.opts.apiUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      this.logger.error("[CheckpointClient] Delete checkpoints request failed", {
        runFriendlyId,
        status: res.status,
      });
      return false;
    }

    return true;
  }

  async cancelCheckpoints({ runFriendlyId }: { runFriendlyId: string }): Promise<boolean> {
    const res = await fetch(
      new URL(`/api/v1/runs/${runFriendlyId}/checkpoints/cancel`, this.opts.apiUrl),
      { method: "POST", signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) }
    );

    if (!res.ok) {
      this.logger.error("[CheckpointClient] Cancel checkpoints request failed", {
        runFriendlyId,
        status: res.status,
      });
      return false;
    }

    return true;
  }
}
