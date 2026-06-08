import { Gauge } from "prom-client";
import { env } from "~/env.server";
import { metricsRegister } from "~/metrics.server";
import { singleton } from "~/utils/singleton";
import {
  RunChangeNotifier,
  type RunChangeInput,
  type RunChangeSubscription,
} from "./runChangeNotifier.server";

/**
 * Process-singleton wiring for the RunChangeNotifier plus the thin, gated
 * convenience functions that write sites and the realtime route delegate to.
 *
 * The notifier is constructed lazily (only on the first publish/subscribe when
 * enabled), so a webapp running with `REALTIME_NOTIFIER_ENABLED=0` (the default)
 * opens no Redis connections and registers no metrics for this subsystem.
 */
const notifierEnabled = env.REALTIME_NOTIFIER_ENABLED === "1";

function initializeRunChangeNotifier(): RunChangeNotifier {
  const notifier = new RunChangeNotifier({
    redis: {
      host: env.PUBSUB_REDIS_HOST,
      port: env.PUBSUB_REDIS_PORT,
      username: env.PUBSUB_REDIS_USERNAME,
      password: env.PUBSUB_REDIS_PASSWORD,
      tlsDisabled: env.PUBSUB_REDIS_TLS_DISABLED === "true",
      clusterMode: env.PUBSUB_REDIS_CLUSTER_MODE_ENABLED === "1",
    },
  });

  new Gauge({
    name: "realtime_run_change_notifier_active_subscriptions",
    help: "Distinct runs currently subscribed for realtime change notifications",
    collect() {
      this.set(notifier.activeSubscriptionCount);
    },
    registers: [metricsRegister],
  });

  return notifier;
}

/** Lazily construct (and memoize) the notifier singleton. */
export function getRunChangeNotifier(): RunChangeNotifier {
  return singleton("runChangeNotifier", initializeRunChangeNotifier);
}

/** Whether the notifier subsystem is enabled for this process. */
export function isRunChangeNotifierEnabled(): boolean {
  return notifierEnabled;
}

/** Fire-and-forget run-changed notify. No-op (and no notifier construction) when disabled. */
export function publishRunChanged(input: RunChangeInput): void {
  if (!notifierEnabled) {
    return;
  }
  getRunChangeNotifier().publish(input);
}

export function publishManyRunChanged(inputs: RunChangeInput[]): void {
  if (!notifierEnabled) {
    return;
  }
  getRunChangeNotifier().publishMany(inputs);
}

/** Subscribe to the next change for a run via the shared subscriber. */
export function subscribeToRunChanges(runId: string): RunChangeSubscription {
  return getRunChangeNotifier().subscribeToRunChanges(runId);
}
