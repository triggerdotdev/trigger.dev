import { context, trace, TraceFlags } from "@opentelemetry/api";
import type { RunEngine } from "@internal/run-engine";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type {
  MollifierDrainerHandler,
  MollifierDrainerTerminalFailureHandler,
} from "@trigger.dev/redis-worker";
import { logger } from "~/services/logger.server";
import { PerformTaskRunAlertsService } from "~/v3/services/alerts/performTaskRunAlerts.server";
import { startSpan } from "~/v3/tracing.server";
import type { MollifierSnapshot } from "./mollifierSnapshot.server";

const tracer = trace.getTracer("mollifier-drainer");

export function isRetryablePgError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  // Prisma surfaces P1001 ("Can't reach database server") via two
  // different error classes — `PrismaClientKnownRequestError` exposes
  // it as `err.code`, `PrismaClientInitializationError` exposes it as
  // `err.errorCode`. Check both so reconnection-time errors retry
  // regardless of which class fires.
  const code = (err as { code?: string }).code;
  const errorCode = (err as { errorCode?: string }).errorCode;
  if (code === "P2024") return true;
  if (code === "P1001" || errorCode === "P1001") return true;
  if (msg.includes("Can't reach database server")) return true;
  if (msg.includes("Connection lost")) return true;
  if (msg.includes("ECONNRESET")) return true;
  return false;
}

export function createDrainerHandler(deps: {
  engine: RunEngine;
  prisma: PrismaClientOrTransaction;
}): MollifierDrainerHandler<MollifierSnapshot> {
  return async (input) => {
    const dwellMs = Date.now() - input.createdAt.getTime();

    // Re-attach to the trace started by the caller's mollifier.queued span
    // (its traceId + spanId were captured into the snapshot at buffer time).
    // Without this the drainer would emit mollifier.drained in a brand-new
    // trace and the engine.trigger instrumentation would inherit an empty
    // active context — leaving the run-detail page with only the root span.
    const snapshotTraceId =
      typeof input.payload.traceId === "string" ? input.payload.traceId : undefined;
    const snapshotSpanId =
      typeof input.payload.spanId === "string" ? input.payload.spanId : undefined;

    const parentContext =
      snapshotTraceId && snapshotSpanId
        ? trace.setSpanContext(context.active(), {
            traceId: snapshotTraceId,
            spanId: snapshotSpanId,
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          })
        : context.active();

    // Cancel-wins-over-trigger. If a cancel API call landed on this
    // entry while it was QUEUED, the snapshot carries `cancelledAt` +
    // `cancelReason`. Skip the normal materialise path and write a
    // CANCELED PG row directly. The `runCancelled` bus emit is
    // suppressed here because a buffered-only run never had a primary
    // trace event written for it — the runCancelled handler's
    // `cancelRunEvent` lookup would fail and log noise per cancel.
    const cancelledAtStr =
      typeof input.payload.cancelledAt === "string" ? input.payload.cancelledAt : undefined;
    if (cancelledAtStr) {
      const cancelReason =
        typeof input.payload.cancelReason === "string"
          ? input.payload.cancelReason
          : "Canceled by user";
      await context.with(parentContext, async () => {
        await startSpan(tracer, "mollifier.drained.cancelled", async (span) => {
          span.setAttribute("mollifier.drained", true);
          span.setAttribute("mollifier.dwell_ms", dwellMs);
          span.setAttribute("mollifier.attempts", input.attempts);
          span.setAttribute("mollifier.run_friendly_id", input.runId);
          span.setAttribute("mollifier.cancel_bifurcation", true);
          span.setAttribute("taskRunId", input.runId);
          try {
            await deps.engine.createCancelledRun(
              {
                snapshot: input.payload as any,
                cancelledAt: new Date(cancelledAtStr),
                cancelReason,
                emitRunCancelledEvent: false,
              },
              deps.prisma,
            );
          } catch (err) {
            // createCancelledRun throws a conflict when the normal trigger
            // replay path won the race and already materialised a live
            // (non-CANCELED) row for this friendlyId. Its contract leaves
            // the resolution to us: honour the cancel by actually
            // cancelling the now-live run. Letting the conflict propagate
            // would instead reach the drainer's terminal-failure path
            // (isRetryablePgError() is false for it), buffer.fail() the
            // entry, and silently lose the cancellation while the run
            // keeps executing.
            const isConflict =
              err instanceof Error && err.message.startsWith("createCancelledRun conflict");
            if (!isConflict) {
              // Mirror the SYSTEM_FAILURE fallback the non-cancelled
              // trigger path uses below. Without this branch, a
              // non-retryable createCancelledRun failure rethrows, the
              // drainer's onTerminalFailure handler skips because it
              // gates on `cause === "max-attempts-exhausted"` (and the
              // outer drainer classifies non-retryable failures with
              // `cause: "non-retryable"`), and buffer.fail() deletes
              // the entry — leaving NO PG row. The cancellation
              // disappears silently from the customer's dashboard.
              // Writing a SYSTEM_FAILURE row gives the run a terminal,
              // visible state.
              if (isRetryablePgError(err)) {
                throw err;
              }
              span.setAttribute("mollifier.cancel_terminal_failure_reason",
                err instanceof Error ? err.message : String(err));
              try {
                const wrote = await writeMollifierTerminalFailureRow(deps, {
                  friendlyId: input.runId,
                  snapshot: input.payload as Record<string, unknown>,
                  reason: err instanceof Error ? err.message : String(err),
                });
                if (wrote) return;
              } catch (writeErr) {
                if (isRetryablePgError(writeErr)) {
                  span.setAttribute("mollifier.cancel_terminal_write_retryable", true);
                  throw writeErr;
                }
                span.setAttribute(
                  "mollifier.cancel_terminal_write_error",
                  writeErr instanceof Error ? writeErr.message : String(writeErr)
                );
              }
              throw err;
            }
            span.setAttribute("mollifier.cancel_conflict", true);
            const friendlyId =
              typeof input.payload.friendlyId === "string"
                ? input.payload.friendlyId
                : input.runId;
            await deps.engine.cancelRun({
              runId: RunId.fromFriendlyId(friendlyId),
              completedAt: new Date(cancelledAtStr),
              reason: cancelReason,
            });
          }
        });
      });
      return;
    }

    await context.with(parentContext, async () => {
      await startSpan(tracer, "mollifier.drained", async (span) => {
        span.setAttribute("mollifier.drained", true);
        span.setAttribute("mollifier.dwell_ms", dwellMs);
        span.setAttribute("mollifier.attempts", input.attempts);
        span.setAttribute("mollifier.run_friendly_id", input.runId);
        span.setAttribute("taskRunId", input.runId);

        try {
          await deps.engine.trigger(input.payload as any, deps.prisma);
        } catch (err) {
          // The retryable-PG class re-throws so the drainer's outer
          // worker loop can `buffer.requeue` (handled in
          // `MollifierDrainer.drainOne`). For non-retryable failures we
          // write a terminal SYSTEM_FAILURE row to PG via the engine's
          // existing `createFailedTaskRun` (used by batch-trigger for
          // the same purpose) so the customer sees the run in their
          // dashboard / SDK instead of silently losing it when the
          // buffer entry TTLs out. If THAT insert also fails (PG truly
          // unreachable), rethrow so the drainer's outer catch falls
          // through to its existing `buffer.fail` terminal-marker path.
          if (isRetryablePgError(err)) {
            throw err;
          }
          const reason = err instanceof Error ? err.message : String(err);
          span.setAttribute("mollifier.terminal_failure_reason", reason);
          try {
            const wrote = await writeMollifierTerminalFailureRow(deps, {
              friendlyId: input.runId,
              snapshot: input.payload as Record<string, unknown>,
              reason,
            });
            if (!wrote) {
              // Snapshot too malformed to even construct a TaskRun row.
              // Drainer's outer catch will buffer.fail this entry.
              throw err;
            }
          } catch (writeErr) {
            // The terminal SYSTEM_FAILURE write itself failed. If it
            // failed because PG is transiently unreachable, rethrow the
            // *write* error so the drainer requeues — buffer.fail()ing on
            // the original non-retryable error would lose the run with no
            // PG row ever landing. Once PG recovers the requeued entry
            // writes its failure row and the customer sees it.
            if (isRetryablePgError(writeErr)) {
              span.setAttribute("mollifier.terminal_write_retryable", true);
              throw writeErr;
            }
            // PG reachable but the write was rejected for another reason
            // (genuinely bad snapshot). Rethrow the original trigger error
            // so the drainer falls back to buffer.fail.
            span.setAttribute(
              "mollifier.terminal_write_error",
              writeErr instanceof Error ? writeErr.message : String(writeErr)
            );
            throw err;
          }
        }
      });
    });
  };
}

// Shared SYSTEM_FAILURE construction used by both terminal paths:
//   - non-retryable failure inside the handler (above)
//   - retryable failure after maxAttempts inside the drainer's
//     `processEntry` (via `createDrainerTerminalFailureHandler`)
//
// Suppresses `runFailed` and enqueues the alert manually — the engine's
// `runFailed` handler calls `completeFailedRunEvent`, which looks up
// the run's primary span. Buffered-only runs never had a primary trace
// event written (the mollifier gate intercepts BEFORE
// `repository.traceEvent` runs), so the lookup always fails and the
// handler logs a systematic `[runFailed] Failed to complete failed
// run event` error per terminal failure. `TriggerFailedTaskService`
// handles the identical situation the same way (see triggerFailedTask
// .server.ts:212 and 324) — pass `emitRunFailedEvent: false` to the
// engine and call `PerformTaskRunAlertsService.enqueue(...)` directly
// so customers' ERROR channels still fire. Alert enqueue is
// best-effort; an alert-side failure is logged but does not bubble up
// (the SYSTEM_FAILURE row landing is the load-bearing customer-visible
// outcome).
//
// Returns the new `TaskRun` on success or `null` when the snapshot was
// so malformed it couldn't even produce an environment — caller decides
// whether to escalate that to `buffer.fail` directly. Throws on any
// other failure so the drainer's retryable/non-retryable disposition
// logic can own the decision.
async function writeMollifierTerminalFailureRow(
  deps: { engine: RunEngine; prisma: PrismaClientOrTransaction },
  args: { friendlyId: string; snapshot: Record<string, unknown>; reason: string },
) {
  const { snapshot } = args;
  const env = snapshot.environment as
    | {
        id: string;
        type: any;
        project: { id: string };
        organization: { id: string };
      }
    | undefined;
  if (!env) return null;
  // Extract batch association from the snapshot if present. Without this
  // a SYSTEM_FAILURE row for a buffered batch child won't be linked to
  // its batch, and the batch parent's completion tracking can hang
  // indefinitely waiting on a child that landed but isn't visible to
  // the batch.
  const rawBatch = snapshot.batch;
  const batch =
    rawBatch &&
    typeof rawBatch === "object" &&
    "id" in rawBatch &&
    typeof (rawBatch as { id: unknown }).id === "string" &&
    "index" in rawBatch &&
    typeof (rawBatch as { index: unknown }).index === "number"
      ? (rawBatch as { id: string; index: number })
      : undefined;
  const failedRun = await deps.engine.createFailedTaskRun({
    friendlyId: args.friendlyId,
    environment: env,
    taskIdentifier: String(snapshot.taskIdentifier ?? ""),
    payload: typeof snapshot.payload === "string" ? snapshot.payload : undefined,
    payloadType: typeof snapshot.payloadType === "string" ? snapshot.payloadType : undefined,
    error: {
      type: "STRING_ERROR",
      raw: `Mollifier drainer terminal failure: ${args.reason}`,
    },
    parentTaskRunId:
      typeof snapshot.parentTaskRunId === "string" ? snapshot.parentTaskRunId : undefined,
    rootTaskRunId:
      typeof snapshot.rootTaskRunId === "string" ? snapshot.rootTaskRunId : undefined,
    depth: typeof snapshot.depth === "number" ? snapshot.depth : 0,
    resumeParentOnCompletion: snapshot.resumeParentOnCompletion === true,
    batch,
    traceId: typeof snapshot.traceId === "string" ? snapshot.traceId : undefined,
    spanId: typeof snapshot.spanId === "string" ? snapshot.spanId : undefined,
    taskEventStore:
      typeof snapshot.taskEventStore === "string" ? snapshot.taskEventStore : undefined,
    queue: typeof snapshot.queue === "string" ? snapshot.queue : undefined,
    lockedQueueId:
      typeof snapshot.lockedQueueId === "string" ? snapshot.lockedQueueId : undefined,
    emitRunFailedEvent: false,
  });
  // Alerts side of `runFailed` — the engine emit was suppressed above
  // so we don't create an orphan trace event; enqueue the alert
  // directly so customers' ERROR channels still see the failure.
  // Best-effort, mirroring TriggerFailedTaskService.
  try {
    await PerformTaskRunAlertsService.enqueue(failedRun.id);
  } catch (alertsError) {
    logger.warn("writeMollifierTerminalFailureRow: alert enqueue failed", {
      friendlyId: args.friendlyId,
      error: alertsError instanceof Error ? alertsError.message : String(alertsError),
    });
  }
  return failedRun;
}

// Drainer-side terminal-failure callback. Fires from
// `MollifierDrainer.processEntry` BEFORE `buffer.fail()` on any path
// where the in-handler write didn't already land — currently the
// `cause: "max-attempts-exhausted"` case for retryable PG errors. Writes
// the same SYSTEM_FAILURE row the non-retryable handler path writes
// inline (via the shared `writeMollifierTerminalFailureRow` helper) so
// the customer-visible behaviour is identical regardless of how the
// failure was classified.
//
// Re-throws retryable PG errors so the drainer requeues — buffer.fail()ing
// here would still lose the run if PG is genuinely unreachable. Throwing
// anything else falls through to buffer.fail to avoid an infinite loop on
// a genuinely bad snapshot (the drainer logs it).
export function createDrainerTerminalFailureHandler(deps: {
  engine: RunEngine;
  prisma: PrismaClientOrTransaction;
}): MollifierDrainerTerminalFailureHandler<MollifierSnapshot> {
  return async (input) => {
    // The handler's own non-retryable terminal path has already written
    // the SYSTEM_FAILURE row before it throws non-retryable. Only the
    // retryable-exhausted path reaches us with no row written yet — gate
    // on `cause` to avoid double-writing for non-retryable failures.
    if (input.cause !== "max-attempts-exhausted") return;
    await startSpan(tracer, "mollifier.drained.terminal_failure", async (span) => {
      span.setAttribute("mollifier.drained", false);
      span.setAttribute("mollifier.attempts", input.attempts);
      span.setAttribute("mollifier.run_friendly_id", input.runId);
      span.setAttribute("mollifier.terminal_failure_cause", input.cause);
      span.setAttribute("mollifier.terminal_failure_reason", input.error.message);
      span.setAttribute("taskRunId", input.runId);
      await writeMollifierTerminalFailureRow(deps, {
        friendlyId: input.runId,
        snapshot: input.payload as Record<string, unknown>,
        reason: input.error.message,
      });
    });
  };
}
