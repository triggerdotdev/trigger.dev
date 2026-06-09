import { Gauge } from "prom-client";
import { env } from "~/env.server";
import { metricsRegister } from "~/metrics.server";
import { singleton } from "~/utils/singleton";
import { RunChangeNotifier, type ChangeRecordInput } from "./runChangeNotifier.server";

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
  const clusterMode = env.REALTIME_RUNS_PUBSUB_REDIS_CLUSTER_MODE_ENABLED === "1";
  // Sharded pub/sub only works against a cluster; classic pub/sub there would
  // broadcast every message to every node, so this is what actually shards load.
  const shardedPubSub = clusterMode && env.REALTIME_RUNS_PUBSUB_REDIS_SHARDED_ENABLED === "1";

  const notifier = new RunChangeNotifier({
    redis: {
      host: env.REALTIME_RUNS_PUBSUB_REDIS_HOST,
      port: env.REALTIME_RUNS_PUBSUB_REDIS_PORT,
      username: env.REALTIME_RUNS_PUBSUB_REDIS_USERNAME,
      password: env.REALTIME_RUNS_PUBSUB_REDIS_PASSWORD,
      tlsDisabled: env.REALTIME_RUNS_PUBSUB_REDIS_TLS_DISABLED === "true",
      clusterMode,
      // One subscriber connection per shard so SSUBSCRIBE routes to the slot owner.
      ...(shardedPubSub ? { clusterOptions: { shardedSubscribers: true } } : {}),
    },
    envWakeCoalesceWindowMs: env.REALTIME_NOTIFIER_ENV_WAKE_COALESCE_WINDOW_MS,
    shardedPubSub,
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

/** Fire-and-forget publish of a run-changed record. No-op (and no notifier construction)
 * when disabled, so publish sites can call it unconditionally. */
export function publishChangeRecord(input: ChangeRecordInput): void {
  if (!notifierEnabled) {
    return;
  }
  getRunChangeNotifier().publish(input);
}

export function publishManyChangeRecords(inputs: ChangeRecordInput[]): void {
  if (!notifierEnabled) {
    return;
  }
  getRunChangeNotifier().publishMany(inputs);
}
