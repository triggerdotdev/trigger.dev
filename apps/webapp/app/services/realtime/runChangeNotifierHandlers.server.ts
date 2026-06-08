import { env } from "~/env.server";
import { engine } from "~/v3/runEngine.server";
import { logger } from "../logger.server";
import { publishRunChanged } from "./runChangeNotifierInstance.server";

/**
 * Registers the run-changed delegations as additive listeners on the Run Engine
 * 2.0 event bus. All logic lives in the notifier
 * module; each listener here is a one-line, fire-and-forget delegate. Because
 * they only attach to engine events, they cover V2 runs exclusively (V1/MarQS
 * never reach this engine), and they're trivially reversible (delete this file +
 * its boot registration).
 *
 * Coverage is intentionally not exhaustive: a dropped or uncovered transition
 * only adds latency because the consumer has a ~5s refetch backstop. We cover the
 * high-value, env-cheap transitions here.
 */
export function registerRunChangeNotifierHandlers() {
  if (env.REALTIME_NOTIFIER_ENABLED !== "1") {
    return;
  }

  // Status transitions (checkpoint suspend/resume, pending version, dequeue) —
  // environment.id is in the payload.
  engine.eventBus.on("runStatusChanged", ({ run, environment }) => {
    publishRunChanged({ runId: run.id, environmentId: environment.id });
  });

  // Dequeue/lock (sets startedAt) and attempt start (DEQUEUED -> EXECUTING) — the
  // most-watched "my run started" transitions.
  engine.eventBus.on("runLocked", ({ run, environment }) => {
    publishRunChanged({ runId: run.id, environmentId: environment.id });
  });
  engine.eventBus.on("runAttemptStarted", ({ run, environment }) => {
    publishRunChanged({ runId: run.id, environmentId: environment.id });
  });

  // Terminal + failure transitions.
  engine.eventBus.on("runSucceeded", ({ run, environment }) => {
    publishRunChanged({ runId: run.id, environmentId: environment.id });
  });
  engine.eventBus.on("runFailed", ({ run, environment }) => {
    publishRunChanged({ runId: run.id, environmentId: environment.id });
  });
  engine.eventBus.on("runExpired", ({ run, environment }) => {
    publishRunChanged({ runId: run.id, environmentId: environment.id });
  });
  engine.eventBus.on("runCancelled", ({ run, environment }) => {
    publishRunChanged({ runId: run.id, environmentId: environment.id });
  });
  engine.eventBus.on("runRetryScheduled", ({ run, environment }) => {
    publishRunChanged({ runId: run.id, environmentId: environment.id });
  });

  // Delay lifecycle (delayUntil / queued-after-delay changes).
  engine.eventBus.on("runDelayRescheduled", ({ run, environment }) => {
    publishRunChanged({ runId: run.id, environmentId: environment.id });
  });
  engine.eventBus.on("runEnqueuedAfterDelay", ({ run, environment }) => {
    publishRunChanged({ runId: run.id, environmentId: environment.id });
  });

  // Attempt failures and metadata updates don't carry environmentId, but the
  // single-run channel is keyed by runId alone.
  engine.eventBus.on("runAttemptFailed", ({ run }) => {
    publishRunChanged({ runId: run.id });
  });
  engine.eventBus.on("runMetadataUpdated", ({ run }) => {
    publishRunChanged({ runId: run.id });
  });

  logger.info("[runChangeNotifier] realtime run-change notifier handlers registered");
}
