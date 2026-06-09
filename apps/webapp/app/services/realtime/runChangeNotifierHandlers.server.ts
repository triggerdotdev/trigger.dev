import { env } from "~/env.server";
import { engine } from "~/v3/runEngine.server";
import { logger } from "../logger.server";
import { publishChangeRecord } from "./runChangeNotifierInstance.server";

/**
 * ChangeRecordBuilder — builds and publishes a self-describing `ChangeRecord` to the run's
 * environment channel for the lifecycle events whose engine-bus payload already carries
 * env + tags + batchId. One publish per change; `envId` is always present.
 *
 * The terminal transitions (runSucceeded/runFailed/runExpired/runCancelled),
 * runAttemptFailed, and runMetadataUpdated publish from `runEngineHandlers.server.ts`
 * instead — those events don't carry env/tags/batchId on the bus, but that file already
 * re-reads the run (or resolves the env) for each, so the publish piggybacks on the
 * existing read rather than widening the event bus. So fully disabling publishing is the
 * env master switch (`REALTIME_NOTIFIER_ENABLED`), not just deleting this file.
 *
 * Coverage is intentionally not exhaustive: a dropped or uncovered transition only adds
 * latency because the consumer has a periodic backstop full-resolve.
 */
export function registerRunChangeNotifierHandlers() {
  // Return a truthy value in every path so the singleton() wrapper (which uses ??=) caches
  // the result and never re-runs this factory — re-running would attach duplicate
  // engine-bus listeners on each Remix dev-mode reload.
  if (env.REALTIME_NOTIFIER_ENABLED !== "1") {
    return true;
  }

  // Run created (trigger). The first signal a tag/batch feed gets for a brand-new run: a
  // freshly-created run is born QUEUED with no status transition, so without this it only
  // surfaces on the consumer's periodic backstop resolve (and not at all before ClickHouse
  // ingests it). Routing the create record hydrates the new run by id straight from Postgres.
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
