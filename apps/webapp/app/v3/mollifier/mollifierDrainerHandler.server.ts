import { context, trace, TraceFlags } from "@opentelemetry/api";
import type { RunEngine } from "@internal/run-engine";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import type { MollifierDrainerHandler } from "@trigger.dev/redis-worker";
import { startSpan } from "~/v3/tracing.server";
import type { MollifierSnapshot } from "./mollifierSnapshot.server";

const tracer = trace.getTracer("mollifier-drainer");

export function isRetryablePgError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  const code = (err as { code?: string }).code;
  if (code === "P2024") return true;
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
          await deps.engine.createCancelledRun(
            {
              snapshot: input.payload as any,
              cancelledAt: new Date(cancelledAtStr),
              cancelReason,
            },
            deps.prisma,
          );
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

        await deps.engine.trigger(input.payload as any, deps.prisma);
      });
    });
  };
}
