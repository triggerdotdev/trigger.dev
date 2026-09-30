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
  /** From the caller's verified deployment token, when it carried one. */
  owner?: RunnerOwner;
};

export type RunTraceContext = {
  traceparent: string;
  envId: string;
  orgId: string;
  projectId: string;
};

export type RunnerSuspendResult = { ok: true; location: string } | { ok: false; error: string };
export type RunnerSuspendRequested = { ok: true } | { ok: false; error: string };
type RunnerOwner = { envId: string; deploymentFriendlyId: string };
export type RunnerSuspendRequest = {
  runnerId: string;
  runFriendlyId: string;
  snapshotFriendlyId: string;
  owner?: RunnerOwner;
};
export type PublishedSuspend = {
  runnerId: string;
  runFriendlyId: string;
  snapshotFriendlyId: string;
  outcome: RunnerSuspendResult;
};

const SUSPEND_RECOVERY_INTERVAL_MS = 60_000;

/**
 * A backend that takes the snapshot and answers with the outcome itself,
 * rather than through the callback route. Only the request counts against the
 * dispatch limit: the wait lasts as long as the snapshot, and a queue behind it
 * would hold suspends that can no longer be cancelled.
 */
export interface RunnerSnapshotter {
  snapshotDelayMs: number;
  snapshotDispatchLimit: number;
  requestSuspend(opts: RunnerSuspendRequest): Promise<RunnerSuspendRequested>;
  awaitSuspend(opts: {
    runnerId: string;
    snapshotFriendlyId: string;
  }): Promise<RunnerSuspendResult>;
  /** Answered suspends not yet marked submitted, which outlive this process. */
  publishedSuspends(): Promise<PublishedSuspend[]>;
  publishedSuspendOf(runnerId: string): Promise<PublishedSuspend | undefined>;
  markSuspendSubmitted(opts: { runnerId: string; snapshotFriendlyId: string }): Promise<void>;
}

export type ComputeSnapshotServiceOptions = {
  /** Exactly one of these two takes the snapshots. */
  computeManager?: ComputeWorkloadManager;
  runnerSnapshotter?: RunnerSnapshotter;
  workerClient: SupervisorHttpClient;
  tracing?: OtlpTraceService;
  wideEventOpts: WideEventOptions;
  snapshotCallbackSecret: string;
  suspendRecoveryIntervalMs?: number;
};

export class ComputeSnapshotService {
  private readonly logger = new SimpleStructuredLogger("compute-snapshot-service");

  private static readonly MAX_TRACE_CONTEXTS = 10_000;
  private readonly runTraceContexts = new Map<string, RunTraceContext>();
  private readonly timerWheel: TimerWheel<DelayedSnapshot>;
  private readonly dispatchLimit: ReturnType<typeof pLimit>;

  private readonly computeManager?: ComputeWorkloadManager;
  private readonly runnerSnapshotter?: RunnerSnapshotter;
  private readonly snapshotDelayMs: number;
  private readonly workerClient: SupervisorHttpClient;
  private readonly tracing?: OtlpTraceService;
  private readonly wideEventOpts: WideEventOptions;
  private readonly snapshotCallbackKey: Buffer;
  private readonly suspendsInFlight = new Set<string>();
  private suspendRecoveryTimer?: ReturnType<typeof setInterval>;
  private recoveringSuspends = false;

  constructor(opts: ComputeSnapshotServiceOptions) {
    this.computeManager = opts.computeManager;
    this.runnerSnapshotter = opts.runnerSnapshotter;
    const backend = opts.computeManager ?? opts.runnerSnapshotter;
    if (!backend || (opts.computeManager && opts.runnerSnapshotter)) {
      throw new Error("exactly one of computeManager and runnerSnapshotter is required");
    }
    this.snapshotDelayMs = backend.snapshotDelayMs;
    this.workerClient = opts.workerClient;
    this.tracing = opts.tracing;
    this.wideEventOpts = opts.wideEventOpts;

    // An empty HMAC key makes callback tokens forgeable. Checked here as well as at
    // env parse because the secret may come from an empty file.
    if (!opts.snapshotCallbackSecret) {
      throw new Error("snapshotCallbackSecret must not be empty");
    }
    // Domain separation, so the raw secret is never used directly as this protocol's MAC key.
    this.snapshotCallbackKey = createHmac("sha256", opts.snapshotCallbackSecret)
      .update(SNAPSHOT_CALLBACK_KEY_INFO)
      .digest();

    this.dispatchLimit = pLimit(backend.snapshotDispatchLimit);
    this.timerWheel = new TimerWheel<DelayedSnapshot>({
      delayMs: this.snapshotDelayMs,
      onExpire: (item) => {
        const dispatched = this.runnerSnapshotter
          ? this.dispatch(item.data)
          : this.dispatchLimit(() => this.dispatch(item.data));
        dispatched.catch((error) => {
          this.logger.error("Snapshot dispatch failed", {
            runId: item.data.runFriendlyId,
            runnerId: item.data.runnerId,
            error,
          });
        });
      },
    });
    this.timerWheel.start();

    if (this.runnerSnapshotter) {
      this.suspendRecoveryTimer = setInterval(
        () => void this.recoverSuspends(),
        opts.suspendRecoveryIntervalMs ?? SUSPEND_RECOVERY_INTERVAL_MS
      );
      this.suspendRecoveryTimer.unref();
      void this.recoverSuspends();
    }
  }

  /**
   * Submits suspend outcomes the backend published that no process delivered,
   * such as one answered while the supervisor restarted, or whose submission
   * failed. A repeat is harmless: the platform discards a checkpoint for a
   * snapshot that is no longer current.
   */
  async recoverSuspends(): Promise<void> {
    const runnerSnapshotter = this.runnerSnapshotter;
    if (!runnerSnapshotter || this.recoveringSuspends) {
      return;
    }
    this.recoveringSuspends = true;
    try {
      const published = await runnerSnapshotter.publishedSuspends();
      for (const suspend of published) {
        if (this.suspendsInFlight.has(suspendKey(suspend))) {
          continue;
        }
        await runWideEvent(
          {
            ...this.wideEventOpts,
            op: "snapshot.recover",
            kind: "scheduled",
            setup: (state) => {
              state.meta.run_id = suspend.runFriendlyId;
              state.meta.snapshot_id = suspend.snapshotFriendlyId;
              state.extras.runner_id = suspend.runnerId;
            },
          },
          () => this.#deliverSuspend(runnerSnapshotter, suspend, suspend.outcome)
        );
      }
    } catch (error) {
      this.logger.error("Suspend recovery failed", { error });
    } finally {
      this.recoveringSuspends = false;
    }
  }

  /**
   * Submits the outcome, then marks it on the Runner so recovery skips it.
   * Returns whether the platform accepted it.
   */
  async #deliverSuspend(
    runnerSnapshotter: RunnerSnapshotter,
    target: { runnerId: string; runFriendlyId: string; snapshotFriendlyId: string },
    outcome: RunnerSuspendResult
  ): Promise<boolean> {
    if (!(await this.#submitCompletion(target.runFriendlyId, target.snapshotFriendlyId, outcome))) {
      return false;
    }
    try {
      await runnerSnapshotter.markSuspendSubmitted({
        runnerId: target.runnerId,
        snapshotFriendlyId: target.snapshotFriendlyId,
      });
    } catch (error) {
      this.logger.warn("Failed to mark suspend submitted", {
        runnerId: target.runnerId,
        snapshotFriendlyId: target.snapshotFriendlyId,
        error,
      });
    }
    return true;
  }

  /**
   * The Runner's status holds only the latest answer, so a new request may
   * replace an earlier one that never reached the platform, leaving nothing
   * for recovery to find. That one is delivered first, and while it cannot be,
   * the new request is refused so the earlier answer stays on the Runner.
   */
  async #deliverEarlierSuspend(
    runnerSnapshotter: RunnerSnapshotter,
    target: { runnerId: string; snapshotFriendlyId: string }
  ): Promise<RunnerSuspendRequested> {
    // An answer its own waiter has yet to read or submit is just as easy to
    // replace, so any other suspend of ours on this Runner holds a new one off.
    const ownKey = suspendKey(target);
    const prefix = `${target.runnerId}/`;
    for (const key of this.suspendsInFlight) {
      if (key !== ownKey && key.startsWith(prefix)) {
        return {
          ok: false,
          error: "an earlier suspend on this Runner is still in flight; retry later",
        };
      }
    }
    let earlier: PublishedSuspend | undefined;
    try {
      earlier = await runnerSnapshotter.publishedSuspendOf(target.runnerId);
    } catch (error) {
      return {
        ok: false,
        error: `suspend request failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!earlier || earlier.snapshotFriendlyId === target.snapshotFriendlyId) {
      return { ok: true };
    }
    if (await this.#deliverSuspend(runnerSnapshotter, earlier, earlier.outcome)) {
      return { ok: true };
    }
    return {
      ok: false,
      error: "an earlier suspend on this Runner has not reached the platform yet; retry later",
    };
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
        state.extras.delay_ms = this.snapshotDelayMs;
      },
    });
    this.logger.debug("Snapshot scheduled", {
      runFriendlyId,
      snapshotFriendlyId: data.snapshotFriendlyId,
      delayMs: this.snapshotDelayMs,
    });
  }

  /**
   * Returns true if a pending snapshot was cancelled. With `runnerId`, only that
   * runner's snapshot, so a stale runner cannot cancel a reassigned run's snapshot.
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

    // The callback route is registered with `wideRoute`, so `fromContext()` is that
    // route's state and these land on its wide event rather than a nested one.
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

    await this.#submitCompletion(
      runId,
      snapshotFriendlyId,
      body.status === "completed"
        ? { ok: true, location: body.snapshot_id }
        : { ok: false, error: body.error ?? "Snapshot failed" }
    );

    return { ok: true as const, status: 200 };
  }

  /** Tells the platform how the suspend went, which is what lets the run move on. */
  async #submitCompletion(
    runId: string,
    snapshotFriendlyId: string,
    outcome: RunnerSuspendResult
  ): Promise<boolean> {
    const state = fromContext();
    const submitStart = performance.now();
    const result = await this.workerClient.submitSuspendCompletion({
      runId,
      snapshotId: snapshotFriendlyId,
      body: outcome.ok
        ? { success: true, checkpoint: { type: "COMPUTE", location: outcome.location } }
        : { success: false, error: outcome.error },
    });
    recordPhaseSince(
      "submit_completion",
      submitStart,
      result.success ? undefined : new Error(String(result.error))
    );

    if (result.success) {
      this.logger.debug("Suspend completion submitted", { runId, outcome });
    } else {
      setExtra(state, "submit_completion.error", String(result.error));
      this.logger.error("Failed to submit suspend completion", {
        runId,
        snapshotFriendlyId,
        outcome,
        error: result.error,
      });
    }
    return result.success;
  }

  registerTraceContext(runFriendlyId: string, ctx: RunTraceContext) {
    // Best-effort: a long-lived run's entry may be evicted before its callback,
    // dropping that span. Acceptable, since spans are observability only.
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
    // Not dispatched: the callback URL dies with this process. Runners reconnect to a
    // new supervisor, which re-triggers the suspend, and runs continue without snapshots.
    clearInterval(this.suspendRecoveryTimer);
    const remaining = this.timerWheel.stop();
    const droppedRuns = remaining.map((item) => item.key);

    if (droppedRuns.length > 0) {
      this.logger.info("Stopped, dropped pending snapshots", { count: droppedRuns.length });
      this.logger.debug("Dropped snapshot details", { runs: droppedRuns });
    }

    return droppedRuns;
  }

  /** Dispatch a snapshot request to whichever backend takes them. */
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
        const runnerSnapshotter = this.runnerSnapshotter;
        if (runnerSnapshotter) {
          const target = {
            runnerId: snapshot.runnerId,
            snapshotFriendlyId: snapshot.snapshotFriendlyId,
          };
          const key = suspendKey(target);
          this.suspendsInFlight.add(key);
          try {
            const requested = await this.dispatchLimit(async () => {
              const earlier = await this.#deliverEarlierSuspend(runnerSnapshotter, target);
              if (!earlier.ok) {
                return earlier;
              }
              return runnerSnapshotter.requestSuspend({
                ...target,
                runFriendlyId: snapshot.runFriendlyId,
                owner: snapshot.owner,
              });
            });
            if (!requested.ok) {
              setExtra(fromContext(), "snapshot.error", requested.error);
              // Nothing was written to the Runner, so there is nothing to mark.
              await this.#submitCompletion(
                snapshot.runFriendlyId,
                snapshot.snapshotFriendlyId,
                requested
              );
              return;
            }
            const outcome = await runnerSnapshotter.awaitSuspend(target);
            if (!outcome.ok) {
              setExtra(fromContext(), "snapshot.error", outcome.error);
            }
            await this.#deliverSuspend(runnerSnapshotter, snapshot, outcome);
          } finally {
            this.suspendsInFlight.delete(key);
          }
          return;
        }

        // The constructor refuses a service with neither backend.
        const computeManager = this.computeManager;
        if (!computeManager) {
          throw new Error("no snapshot backend");
        }
        const callbackNonce = randomBytes(16).toString("hex");
        const result = await computeManager.snapshot({
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
   * The token binds only what is known at dispatch (nonce, run, snapshot), not the
   * result fields the gateway produces later, and is stateless, so not single-use.
   * It stops a caller that can merely reach the endpoint forging a result. Replay or
   * tampering with result fields relies on the callback channel being authenticated
   * and encrypted.
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

function suspendKey(target: { runnerId: string; snapshotFriendlyId: string }): string {
  return `${target.runnerId}/${target.snapshotFriendlyId}`;
}
