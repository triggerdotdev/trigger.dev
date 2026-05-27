import { context, trace, TraceFlags } from "@opentelemetry/api";
import type { RunEngine } from "@internal/run-engine";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type { MollifierDrainerHandler } from "@trigger.dev/redis-worker";
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

    // Cancel-wins-over-trigger (Q4 bifurcation). If a cancel API call
    // landed on this entry while it was QUEUED, the snapshot carries
    // `cancelledAt` + `cancelReason`. Skip the normal materialise path
    // and write a CANCELED PG row directly. The existing runCancelled
    // handler writes the TaskEvent.
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
          const snapshot = input.payload as Record<string, unknown>;
          const env = snapshot.environment as
            | {
                id: string;
                type: any;
                project: { id: string };
                organization: { id: string };
              }
            | undefined;
          if (!env) {
            // Snapshot too malformed to even construct a TaskRun row.
            // Drainer's outer catch will buffer.fail this entry.
            throw err;
          }
          try {
            await deps.engine.createFailedTaskRun({
              friendlyId: input.runId,
              environment: env,
              taskIdentifier: String(snapshot.taskIdentifier ?? ""),
              payload: typeof snapshot.payload === "string" ? snapshot.payload : undefined,
              payloadType:
                typeof snapshot.payloadType === "string" ? snapshot.payloadType : undefined,
              error: {
                type: "STRING_ERROR",
                raw: `Mollifier drainer terminal failure: ${reason}`,
              },
              parentTaskRunId:
                typeof snapshot.parentTaskRunId === "string"
                  ? snapshot.parentTaskRunId
                  : undefined,
              rootTaskRunId:
                typeof snapshot.rootTaskRunId === "string"
                  ? snapshot.rootTaskRunId
                  : undefined,
              depth: typeof snapshot.depth === "number" ? snapshot.depth : 0,
              resumeParentOnCompletion: snapshot.resumeParentOnCompletion === true,
              traceId: typeof snapshot.traceId === "string" ? snapshot.traceId : undefined,
              spanId: typeof snapshot.spanId === "string" ? snapshot.spanId : undefined,
              taskEventStore:
                typeof snapshot.taskEventStore === "string"
                  ? snapshot.taskEventStore
                  : undefined,
              queue: typeof snapshot.queue === "string" ? snapshot.queue : undefined,
              lockedQueueId:
                typeof snapshot.lockedQueueId === "string" ? snapshot.lockedQueueId : undefined,
            });
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
