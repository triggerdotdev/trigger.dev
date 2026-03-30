import pLimit from "p-limit";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { parseTraceparent } from "@trigger.dev/core/v3/isomorphic";
import type { SupervisorHttpClient } from "@trigger.dev/core/v3/workers";
import { type SnapshotCallbackPayload } from "@internal/compute";
import type { ComputeWorkloadManager } from "../workloadManager/compute.js";
import { TimerWheel } from "./timerWheel.js";
import type { OtlpTraceService } from "./otlpTraceService.js";

type DelayedSnapshot = {
  runnerId: string;
  runFriendlyId: string;
  snapshotFriendlyId: string;
};

export type RunTraceContext = {
  traceparent: string;
  envId: string;
  orgId: string;
  projectId: string;
};

export type ComputeSnapshotServiceOptions = {
  computeManager: ComputeWorkloadManager;
  workerClient: SupervisorHttpClient;
  tracing?: OtlpTraceService;
};

export class ComputeSnapshotService {
  private readonly logger = new SimpleStructuredLogger("compute-snapshot-service");

  private static readonly MAX_TRACE_CONTEXTS = 10_000;
  private readonly runTraceContexts = new Map<string, RunTraceContext>();
  private readonly timerWheel: TimerWheel<DelayedSnapshot>;
  private readonly dispatchLimit: ReturnType<typeof pLimit>;

  private readonly computeManager: ComputeWorkloadManager;
  private readonly workerClient: SupervisorHttpClient;
  private readonly tracing?: OtlpTraceService;

  constructor(opts: ComputeSnapshotServiceOptions) {
    this.computeManager = opts.computeManager;
    this.workerClient = opts.workerClient;
    this.tracing = opts.tracing;

    this.dispatchLimit = pLimit(this.computeManager.snapshotDispatchLimit);
    this.timerWheel = new TimerWheel<DelayedSnapshot>({
      delayMs: this.computeManager.snapshotDelayMs,
      onExpire: (item) => {
        this.dispatchLimit(() => this.dispatch(item.data)).catch((error) => {
          this.logger.error("Snapshot dispatch failed", {
            runId: item.data.runFriendlyId,
            runnerId: item.data.runnerId,
            error,
          });
        });
      },
    });
    this.timerWheel.start();
  }

  /** Schedule a delayed snapshot for a run. Replaces any pending snapshot for the same run. */
  schedule(runFriendlyId: string, data: DelayedSnapshot) {
    this.timerWheel.submit(runFriendlyId, data);
    this.logger.debug("Snapshot scheduled", {
      runFriendlyId,
      snapshotFriendlyId: data.snapshotFriendlyId,
      delayMs: this.computeManager.snapshotDelayMs,
    });
  }

  /** Cancel a pending delayed snapshot. Returns true if one was cancelled. */
  cancel(runFriendlyId: string): boolean {
    const cancelled = this.timerWheel.cancel(runFriendlyId);
    if (cancelled) {
      this.logger.debug("Snapshot cancelled", { runFriendlyId });
    }
    return cancelled;
  }

  /** Handle the callback from the gateway after a snapshot completes or fails. */
  async handleCallback(body: SnapshotCallbackPayload) {
    this.logger.debug("Snapshot callback", {
      snapshotId: body.snapshot_id,
      instanceId: body.instance_id,
      status: body.status,
      error: body.error,
      metadata: body.metadata,
      durationMs: body.duration_ms,
    });

    const runId = body.metadata?.runId;
    const snapshotFriendlyId = body.metadata?.snapshotFriendlyId;

    if (!runId || !snapshotFriendlyId) {
      this.logger.error("Snapshot callback missing metadata", { body });
      return { ok: false as const, status: 400 };
    }

    this.#emitSnapshotSpan(runId, body.duration_ms, body.snapshot_id);

    if (body.status === "completed") {
      const result = await this.workerClient.submitSuspendCompletion({
        runId,
        snapshotId: snapshotFriendlyId,
        body: {
          success: true,
          checkpoint: {
            type: "COMPUTE",
            location: body.snapshot_id,
          },
        },
      });

      if (result.success) {
        this.logger.debug("Suspend completion submitted", {
          runId,
          instanceId: body.instance_id,
          snapshotId: body.snapshot_id,
        });
      } else {
        this.logger.error("Failed to submit suspend completion", {
          runId,
          snapshotFriendlyId,
          error: result.error,
        });
      }
    } else {
      const result = await this.workerClient.submitSuspendCompletion({
        runId,
        snapshotId: snapshotFriendlyId,
        body: {
          success: false,
          error: body.error ?? "Snapshot failed",
        },
      });

      if (!result.success) {
        this.logger.error("Failed to submit suspend failure", {
          runId,
          snapshotFriendlyId,
          error: result.error,
        });
      }
    }

    return { ok: true as const, status: 200 };
  }

  registerTraceContext(runFriendlyId: string, ctx: RunTraceContext) {
    // Evict oldest entries if we've hit the cap. This is best-effort: on a busy
    // supervisor, entries for long-lived runs may be evicted before their snapshot
    // callback arrives, causing those snapshot spans to be silently dropped.
    // That's acceptable - trace spans are observability sugar, not correctness.
    if (this.runTraceContexts.size >= ComputeSnapshotService.MAX_TRACE_CONTEXTS) {
      const firstKey = this.runTraceContexts.keys().next().value;
      if (firstKey) {
        this.runTraceContexts.delete(firstKey);
      }
    }

    this.runTraceContexts.set(runFriendlyId, ctx);
  }

  /** Stop the timer wheel, dropping pending snapshots. */
  stop(): string[] {
    // Intentionally drop pending snapshots rather than dispatching them. The supervisor
    // is shutting down, so our callback URL will be dead by the time the gateway responds.
    // Runners detect the supervisor is gone and reconnect to a new instance, which
    // re-triggers the snapshot workflow. Snapshots are an optimization, not a correctness
    // requirement - runs continue fine without them.
    const remaining = this.timerWheel.stop();
    const droppedRuns = remaining.map((item) => item.key);

    if (droppedRuns.length > 0) {
      this.logger.info("Stopped, dropped pending snapshots", { count: droppedRuns.length });
      this.logger.debug("Dropped snapshot details", { runs: droppedRuns });
    }

    return droppedRuns;
  }

  /** Dispatch a snapshot request to the gateway. */
  private async dispatch(snapshot: DelayedSnapshot): Promise<void> {
    const result = await this.computeManager.snapshot({
      runnerId: snapshot.runnerId,
      metadata: {
        runId: snapshot.runFriendlyId,
        snapshotFriendlyId: snapshot.snapshotFriendlyId,
      },
    });

    if (!result) {
      this.logger.error("Failed to request snapshot", {
        runId: snapshot.runFriendlyId,
        runnerId: snapshot.runnerId,
      });
    }
  }

  #emitSnapshotSpan(runFriendlyId: string, durationMs?: number, snapshotId?: string) {
    if (!this.tracing) return;

    const ctx = this.runTraceContexts.get(runFriendlyId);
    if (!ctx) return;

    const parsed = parseTraceparent(ctx.traceparent);
    if (!parsed) return;

    const endEpochMs = Date.now();
    const startEpochMs = durationMs ? endEpochMs - durationMs : endEpochMs;

    const spanAttributes: Record<string, string | number | boolean> = {
      "compute.type": "snapshot",
    };

    if (durationMs !== undefined) {
      spanAttributes["compute.total_ms"] = durationMs;
    }

    if (snapshotId) {
      spanAttributes["compute.snapshot_id"] = snapshotId;
    }

    this.tracing.emit({
      traceId: parsed.traceId,
      parentSpanId: parsed.spanId,
      spanName: "compute.snapshot",
      startTimeMs: startEpochMs,
      endTimeMs: endEpochMs,
      resourceAttributes: {
        "ctx.environment.id": ctx.envId,
        "ctx.organization.id": ctx.orgId,
        "ctx.project.id": ctx.projectId,
        "ctx.run.id": runFriendlyId,
      },
      spanAttributes,
    });
  }
}
