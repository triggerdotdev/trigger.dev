import type { SupervisorHttpClient } from "../runEngineWorker/index.js";
import { WORKER_HEADERS } from "../runEngineWorker/consts.js";
import type {
  CheckpointServiceRestoreRequestBodyInput,
  CheckpointServiceSuspendRequestBodyInput,
} from "../schemas/checkpoints.js";
import { CheckpointServiceSuspendResponseBody } from "../schemas/checkpoints.js";
import type { CheckpointType } from "../schemas/runEngine.js";
import { calculateNextRetryDelay } from "../utils/retries.js";
import { SimpleStructuredLogger } from "../utils/structuredLogger.js";

/** Bounded retries for `deleteSnapshots`, whose service may be briefly down while it restarts. */
export type SnapshotDeleteRetry = {
  maxAttempts?: number;
  /** Jittered backoff doubling from `minDelayMs` up to `maxDelayMs`. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** No attempt starts, and none runs, past this much time from the first. */
  budgetMs?: number;
  attemptTimeoutMs?: number;
};

export type CheckpointClientOptions = {
  apiUrl: URL;
  workerClient: SupervisorHttpClient;
  orchestrator: CheckpointType;
  managedWorkerSecret?: string;
  snapshotDeleteRetry?: SnapshotDeleteRetry;
};

/**
 * How a `deleteSnapshots` call ended. `gave_up` means every attempt hit a temporary failure;
 * `rejected` means the service refused it (e.g. 400 or 401), which a retry cannot fix.
 */
export type SnapshotDeleteResult = {
  outcome: "accepted" | "rejected" | "gave_up";
  attempts: number;
  status?: number;
};

const CANCEL_TIMEOUT_MS = 5_000;

// Service down or restarting (502/503/504, or no response at all) or rate limited (429).
const SNAPSHOT_DELETE_RETRY_STATUSES = new Set([429, 502, 503, 504]);

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
          ...(this.opts.managedWorkerSecret
            ? { [WORKER_HEADERS.MANAGED_SECRET]: this.opts.managedWorkerSecret }
            : {}),
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

  /**
   * Ask the checkpoint service to reclaim a finished run's suspend snapshots. The project is its ID,
   * not its ref. Sends the managed worker secret, which the service requires. Retries a service
   * that is down or busy for a bounded time; the service enqueues once per run, so a repeat is
   * safe. `accepted` means queued, not deleted.
   */
  async deleteSnapshots({
    runFriendlyId,
    body,
  }: {
    runFriendlyId: string;
    body: {
      orgId: string;
      envId: string;
      projectId: string;
      deploymentVersion: string;
    };
  }): Promise<SnapshotDeleteResult> {
    const {
      maxAttempts = 6,
      minDelayMs = 1_000,
      maxDelayMs = 30_000,
      budgetMs = 120_000,
      attemptTimeoutMs = 10_000,
    } = this.opts.snapshotDeleteRetry ?? {};
    const deadline = Date.now() + budgetMs;

    for (let attempt = 1; ; attempt++) {
      let status: number | undefined;
      try {
        const res = await fetch(
          new URL(`/api/v1/runs/${runFriendlyId}/snapshots/delete`, this.opts.apiUrl),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(this.opts.managedWorkerSecret
                ? { [WORKER_HEADERS.MANAGED_SECRET]: this.opts.managedWorkerSecret }
                : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(attemptTimeoutMs, deadline - Date.now()))
            ),
          }
        );
        status = res.status;
        // Nothing reads the body; release it so its connection is free for the next attempt.
        await res.body?.cancel().catch(() => {});
        if (res.ok) {
          return { outcome: "accepted", attempts: attempt, status };
        }
      } catch (error) {
        // No response: refused connection, reset, or the attempt timed out.
        this.logger.warn("[CheckpointClient] Delete snapshots request errored", {
          runFriendlyId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (status !== undefined && !SNAPSHOT_DELETE_RETRY_STATUSES.has(status)) {
        this.logger.error("[CheckpointClient] Delete snapshots request rejected", {
          runFriendlyId,
          status,
        });
        return { outcome: "rejected", attempts: attempt, status };
      }

      const delay = calculateNextRetryDelay(
        {
          minTimeoutInMs: minDelayMs,
          maxTimeoutInMs: maxDelayMs,
          factor: 2,
          randomize: true,
          maxAttempts,
        },
        attempt
      );

      if (delay === undefined || Date.now() + delay >= deadline) {
        this.logger.error("[CheckpointClient] Delete snapshots request gave up", {
          runFriendlyId,
          attempts: attempt,
          status,
        });
        return { outcome: "gave_up", attempts: attempt, status };
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
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
