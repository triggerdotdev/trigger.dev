import type { ReadClient, RunStore } from "@internal/run-store";
import { tryCatch } from "@trigger.dev/core/utils";
import { logger } from "~/services/logger.server";

// The root run can have a parent span from outside its trace (a traceparent passed through
// another service), written shortly before it. A day covers that for at most one extra daily
// partition; an older parent is dropped and its overrides are lost.
const TRACE_ROOT_INSERTED_AT_BUFFER_MS = 24 * 60 * 60 * 1000;

type TraceRun = {
  friendlyId: string;
  createdAt: Date;
  rootTaskRunId: string | null;
  runtimeEnvironmentId: string;
};

// Ancestor reads start where the trace's root run (or this run, when it has none) was created.
export async function getTraceAncestorInsertedAtStart(
  run: TraceRun,
  store: RunStore,
  client?: ReadClient
): Promise<Date | undefined> {
  if (!run.rootTaskRunId) {
    return new Date(run.createdAt.getTime() - TRACE_ROOT_INSERTED_AT_BUFFER_MS);
  }

  const rootCreatedAt = await findRootCreatedAt(run.rootTaskRunId, run, store, client);
  if (!rootCreatedAt) {
    return undefined;
  }

  return new Date(rootCreatedAt.getTime() - TRACE_ROOT_INSERTED_AT_BUFFER_MS);
}

async function findRootCreatedAt(
  rootTaskRunId: string,
  run: TraceRun,
  store: RunStore,
  client?: ReadClient
): Promise<Date | undefined> {
  const [error, root] = await tryCatch(
    store.findRun(
      { id: rootTaskRunId, runtimeEnvironmentId: run.runtimeEnvironmentId },
      { select: { createdAt: true } },
      client
    )
  );

  if (error) {
    logger.warn("Trace root run lookup failed, ancestor reads stay unbounded", {
      runId: run.friendlyId,
      error: error.message,
    });
    return undefined;
  }

  return root?.createdAt;
}
