import { env } from "~/env.server";
import { engine } from "~/v3/runEngine.server";
import { logger } from "../logger.server";
import { publishChangeRecord } from "./runChangeNotifierInstance.server";

/**
 * Builds and publishes a self-describing `ChangeRecord` for the lifecycle events whose engine-bus payload
 * already carries env + tags + batchId. Terminal transitions, runAttemptFailed, and runMetadataUpdated publish
 * from `runEngineHandlers.server.ts` instead. Coverage isn't exhaustive — a dropped transition only adds latency
 * because the consumer has a periodic backstop full-resolve. The env master switch is `REALTIME_BACKEND_NATIVE_ENABLED`.
 */
export function registerRunChangeNotifierHandlers() {
  // Return truthy in every path so singleton() caches this factory and never re-runs it (re-running would attach duplicate engine-bus listeners on dev reload).
  if (env.REALTIME_BACKEND_NATIVE_ENABLED !== "1") {
    return true;
  }

  // Run created: the first signal for a brand-new run (born QUEUED with no status transition), so it surfaces before ClickHouse ingests it.
  engine.eventBus.on("runCreated", ({ run, environment }) => {
    publishChangeRecord({
      runId: run.id,
      envId: environment.id,
      tags: run.runTags,
      batchId: run.batchId,
    });
  });

  // Status transitions (checkpoint suspend/resume, pending version, dequeue).
  engine.eventBus.on("runStatusChanged", ({ run, environment }) => {
    publishChangeRecord({
      runId: run.id,
      envId: environment.id,
      tags: run.runTags,
      batchId: run.batchId,
    });
  });

  // Dequeue/lock (sets startedAt) and attempt start (DEQUEUED -> EXECUTING) — the
  // most-watched "my run started" transitions.
  engine.eventBus.on("runLocked", ({ run, environment }) => {
    publishChangeRecord({
      runId: run.id,
      envId: environment.id,
      tags: run.runTags,
      batchId: run.batchId,
    });
  });
  engine.eventBus.on("runAttemptStarted", ({ run, environment }) => {
    publishChangeRecord({
      runId: run.id,
      envId: environment.id,
      tags: run.runTags,
      batchId: run.batchId,
    });
  });

  engine.eventBus.on("runRetryScheduled", ({ run, environment }) => {
    publishChangeRecord({
      runId: run.id,
      envId: environment.id,
      tags: run.runTags,
      batchId: run.batchId,
    });
  });

  // Delay lifecycle (delayUntil / queued-after-delay changes).
  engine.eventBus.on("runDelayRescheduled", ({ run, environment }) => {
    publishChangeRecord({
      runId: run.id,
      envId: environment.id,
      tags: run.runTags,
      batchId: run.batchId,
    });
  });
  engine.eventBus.on("runEnqueuedAfterDelay", ({ run, environment }) => {
    publishChangeRecord({
      runId: run.id,
      envId: environment.id,
      tags: run.runTags,
      batchId: run.batchId,
    });
  });

  logger.info("[runChangeNotifier] realtime change-record builder registered");

  return true;
}
