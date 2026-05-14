import { trace } from "@opentelemetry/api";
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

    await startSpan(tracer, "mollifier.drained", async (span) => {
      span.setAttribute("mollifier.drained", true);
      span.setAttribute("mollifier.dwell_ms", dwellMs);
      span.setAttribute("mollifier.attempts", input.attempts);
      span.setAttribute("mollifier.run_friendly_id", input.runId);

      await deps.engine.trigger(input.payload as any, deps.prisma);
    });
  };
}
