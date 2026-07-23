import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import pLimit from "p-limit";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { parseTraceparent } from "@trigger.dev/core/v3/isomorphic";
import type { SupervisorHttpClient } from "@trigger.dev/core/v3/workers";
import { type SnapshotCallbackPayload } from "@internal/compute";
import type { ComputeWorkloadManager } from "../workloadManager/compute.js";
import { TimerWheel } from "./timerWheel.js";
import type { OtlpTraceService } from "./otlpTraceService.js";
import {
  emitOneShot,
  fromContext,
  recordPhaseSince,
  runWideEvent,
  setExtra,
  setMeta,
  type WideEventOptions,
} from "../wideEvents/index.js";

const SNAPSHOT_CALLBACK_NONCE_METADATA_KEY = "snapshotCallbackNonce";
const SNAPSHOT_CALLBACK_TOKEN_METADATA_KEY = "snapshotCallbackToken";

// Domain-separation label so the callback-signing key is derived from, rather
// than equal to, the secret used for other protocols. Bump the suffix to rotate.
const SNAPSHOT_CALLBACK_KEY_INFO = "compute-snapshot-callback-v1";

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
  wideEventOpts: WideEventOptions;
  snapshotCallbackSecret: string;
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
  private readonly wideEventOpts: WideEventOptions;
  private readonly snapshotCallbackKey: Buffer;

  constructor(opts: ComputeSnapshotServiceOptions) {
    this.computeManager = opts.computeManager;
    this.workerClient = opts.workerClient;
    this.tracing = opts.tracing;
    this.wideEventOpts = opts.wideEventOpts;

    // Reject an empty secret up front: an empty HMAC key would make callback
    // tokens forgeable by anyone. Guarding here (rather than only at env parse)
    // also covers the case where the secret is read from an empty file.
    if (!opts.snapshotCallbackSecret) {
      throw new Error("snapshotCallbackSecret must not be empty");
    }
    // Derive a dedicated key by domain separation so the raw secret is never
    // used directly as a MAC key for this protocol.
    this.snapshotCallbackKey = createHmac("sha256", opts.snapshotCallbackSecret)
      .update(SNAPSHOT_CALLBACK_KEY_INFO)
      .digest();

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
    emitOneShot({
      ...this.wideEventOpts,
      op: "snapshot.schedule",
      kind: "event",
      populate: (state) => {
        state.meta.run_id = runFriendlyId;
        state.meta.snapshot_id = data.snapshotFriendlyId;
        state.extras.runner_id = data.runnerId;
        state.extras.delay_ms = this.computeManager.snapshotDelayMs;
      },
    });
    this.logger.debug("Snapshot scheduled", {
      runFriendlyId,
      snapshotFriendlyId: data.snapshotFriendlyId,
      delayMs: this.computeManager.snapshotDelayMs,
    });
  }

  /**
   * Cancel a pending delayed snapshot. Returns true if one was cancelled.
   * When `runnerId` is given, only a snapshot scheduled for that same runner
   * is cancelled - a stale runner for a run that has since been reassigned
   * must not cancel the new runner's pending snapshot.
   */
  cancel(runFriendlyId: string, runnerId?: string): boolean {
    if (runnerId) {
      const pending = this.timerWheel.peek(runFriendlyId);
      if (pending && pending.data.runnerId !== runnerId) {
        return false;
      }
    }
    const cancelled = this.timerWheel.cancel(runFriendlyId);
    if (cancelled) {
      emitOneShot({
        ...this.wideEventOpts,
        op: "snapshot.canceled",
        kind: "event",
        populate: (state) => {
          state.meta.run_id = runFriendlyId;
        },
      });
      this.logger.debug("Snapshot cancelled", { runFriendlyId });
    }
    return cancelled;
  }

  /** Handle the callback from the gateway after a snapshot completes or fails. */
  async handleCallback(body: SnapshotCallbackPayload) {
    const snapshotId = body.status === "completed" ? body.snapshot_id : undefined;
    const runId = body.metadata?.runId;
    const snapshotFriendlyId = body.metadata?.snapshotFriendlyId;

    // Enrich the wrapping route's wide event with snapshot metadata. The
    // `/api/v1/compute/snapshot-complete` route is registered with `wideRoute`,
    // so `fromContext()` returns the State of that route and these calls
    // become extras/meta on the same wide event - no nested emission.
    const state = fromContext();
    if (state) {
      state.extras["snapshot.status"] = body.status;
      if (body.instance_id) state.extras["snapshot.instance_id"] = body.instance_id;
      if (body.duration_ms !== undefined) state.extras["snapshot.duration_ms"] = body.duration_ms;
      if (snapshotId) state.extras["snapshot.id"] = snapshotId;
      if (body.status === "failed" && body.error) state.extras["snapshot.error"] = body.error;
    }
    if (runId) setMeta(state, "run_id", runId);
    if (snapshotFriendlyId) setMeta(state, "snapshot_id", snapshotFriendlyId);

    this.logger.debug("Snapshot callback", {
      snapshotId,
      instanceId: body.instance_id,
      status: body.status,
      error: body.status === "failed" ? body.error : undefined,
      runId,
      snapshotFriendlyId,
      durationMs: body.duration_ms,
    });

    if (!runId || !snapshotFriendlyId) {
      this.logger.error("Snapshot callback missing metadata", {
        status: body.status,
        instanceId: body.instance_id,
        metadataKeys: Object.keys(body.metadata ?? {}),
      });
      return { ok: false as const, status: 400 };
    }

    if (!this.#verifyCallbackToken(body.metadata, runId, snapshotFriendlyId)) {
      this.logger.error("Snapshot callback failed token verification", {
        runId,
        snapshotFriendlyId,
        instanceId: body.instance_id,
      });
      return { ok: false as const, status: 401 };
    }

    this.#emitSnapshotSpan(runId, body.duration_ms, snapshotId);

    if (body.status === "completed") {
      const submitStart = performance.now();
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
      recordPhaseSince(
        "submit_completion",
        submitStart,
        result.success ? undefined : new Error(String(result.error))
      );

      if (result.success) {
        this.logger.debug("Suspend completion submitted", {
          runId,
          instanceId: body.instance_id,
          snapshotId: body.snapshot_id,
        });
      } else {
        setExtra(state, "submit_completion.error", String(result.error));
        this.logger.error("Failed to submit suspend completion", {
          runId,
          snapshotFriendlyId,
          error: result.error,
        });
      }
    } else {
      const submitStart = performance.now();
      const result = await this.workerClient.submitSuspendCompletion({
        runId,
        snapshotId: snapshotFriendlyId,
        body: {
          success: false,
          error: body.error ?? "Snapshot failed",
        },
      });
      recordPhaseSince(
        "submit_completion",
        submitStart,
        result.success ? undefined : new Error(String(result.error))
      );

      if (!result.success) {
        setExtra(state, "submit_completion.error", String(result.error));
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
    await runWideEvent(
      {
        ...this.wideEventOpts,
        op: "snapshot.dispatch",
        kind: "scheduled",
        setup: (state) => {
          state.meta.run_id = snapshot.runFriendlyId;
          state.meta.snapshot_id = snapshot.snapshotFriendlyId;
          state.extras.runner_id = snapshot.runnerId;
        },
      },
      async () => {
        const callbackNonce = randomBytes(16).toString("hex");
        const result = await this.computeManager.snapshot({
          runnerId: snapshot.runnerId,
          metadata: {
            runId: snapshot.runFriendlyId,
            snapshotFriendlyId: snapshot.snapshotFriendlyId,
            [SNAPSHOT_CALLBACK_NONCE_METADATA_KEY]: callbackNonce,
            [SNAPSHOT_CALLBACK_TOKEN_METADATA_KEY]: this.#createCallbackToken(
              callbackNonce,
              snapshot.runFriendlyId,
              snapshot.snapshotFriendlyId
            ),
          },
        });

        if (!result) {
          throw new Error("Snapshot dispatch returned no result");
        }
      }
    );
  }

  #createCallbackToken(nonce: string, runFriendlyId: string, snapshotFriendlyId: string): string {
    return createHmac("sha256", this.snapshotCallbackKey)
      .update(nonce)
      .update("\0")
      .update(runFriendlyId)
      .update("\0")
      .update(snapshotFriendlyId)
      .digest("hex");
  }

  /**
   * Verify that a callback carries a token this supervisor issued for the given
   * run and snapshot. The token binds only the identifiers known at dispatch
   * time (nonce, run, snapshot); it intentionally does not cover result fields
   * such as the snapshot location or status/error, which are produced by the
   * gateway after the snapshot and so cannot be signed in advance. Verification
   * is also stateless, so a token is not single-use.
   *
   * This closes the primary risk (a caller that can merely reach the endpoint
   * cannot mint a valid token, so cannot forge a result for an arbitrary run).
   * It does not defend against an attacker who can observe a genuine callback
   * and then replay it or alter its unsigned result fields - that relies on the
   * gateway->supervisor callback channel being authenticated and encrypted.
   */
  #verifyCallbackToken(
    metadata: Record<string, string> | undefined,
    runFriendlyId: string,
    snapshotFriendlyId: string
  ): boolean {
    const nonce = metadata?.[SNAPSHOT_CALLBACK_NONCE_METADATA_KEY];
    const token = metadata?.[SNAPSHOT_CALLBACK_TOKEN_METADATA_KEY];

    if (!nonce || !token) {
      return false;
    }

    const expected = this.#createCallbackToken(nonce, runFriendlyId, snapshotFriendlyId);
    const expectedBuffer = Buffer.from(expected, "hex");
    const tokenBuffer = Buffer.from(token, "hex");

    return (
      expectedBuffer.length === tokenBuffer.length && timingSafeEqual(expectedBuffer, tokenBuffer)
    );
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
