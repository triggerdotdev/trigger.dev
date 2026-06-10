import { getMeter } from "@internal/tracing";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { RunChangeNotifier, type ChangeRecordInput } from "./runChangeNotifier.server";

/**
 * Process-singleton wiring for the RunChangeNotifier plus the gated convenience functions write sites
 * delegate to. The notifier is constructed lazily, so `REALTIME_BACKEND_NATIVE_ENABLED=0` (default) opens no Redis connections.
 */
const nativeBackendEnabled = env.REALTIME_BACKEND_NATIVE_ENABLED === "1";

function initializeRunChangeNotifier(): RunChangeNotifier {
  const clusterMode = env.REALTIME_BACKEND_NATIVE_PUBSUB_REDIS_CLUSTER_MODE_ENABLED === "1";
  // Sharded pub/sub only works against a cluster; classic pub/sub there would
  // broadcast every message to every node, so this is what actually shards load.
  const shardedPubSub = clusterMode && env.REALTIME_BACKEND_NATIVE_PUBSUB_REDIS_SHARDED_ENABLED === "1";

  const meter = getMeter("realtime-notifier");

  const publishes = meter.createCounter("realtime_notifier.publishes", {
    description:
      "Change-record publishes by outcome. Failures are the leading indicator that feeds are degrading to their backstops (pub/sub Redis trouble).",
  });

  const received = meter.createCounter("realtime_notifier.messages_received", {
    description: "Raw channel messages received by this instance's subscriber, pre-coalesce.",
  });

  const delivered = meter.createCounter("realtime_notifier.batches_delivered", {
    description:
      "Coalesced batches delivered to listeners. received/batches = the coalesce ratio (how hard a busy env is being collapsed).",
  });

  const notifier = new RunChangeNotifier({
    redis: {
      host: env.REALTIME_BACKEND_NATIVE_PUBSUB_REDIS_HOST,
      port: env.REALTIME_BACKEND_NATIVE_PUBSUB_REDIS_PORT,
      username: env.REALTIME_BACKEND_NATIVE_PUBSUB_REDIS_USERNAME,
      password: env.REALTIME_BACKEND_NATIVE_PUBSUB_REDIS_PASSWORD,
      tlsDisabled: env.REALTIME_BACKEND_NATIVE_PUBSUB_REDIS_TLS_DISABLED === "true",
      clusterMode,
      // One subscriber connection per shard so SSUBSCRIBE routes to the slot owner.
      ...(shardedPubSub ? { clusterOptions: { shardedSubscribers: true } } : {}),
    },
    envWakeCoalesceWindowMs: env.REALTIME_BACKEND_NATIVE_ENV_WAKE_COALESCE_WINDOW_MS,
    shardedPubSub,
    onPublishResult: (ok) => publishes.add(1, { result: ok ? "ok" : "error" }),
    onMessageReceived: () => received.add(1),
    onBatchDelivered: () => delivered.add(1),
  });

  meter
    .createObservableGauge("realtime_notifier.active_subscriptions", {
      description: "Distinct env channels currently subscribed for realtime change notifications.",
    })
    .addCallback((result) => result.observe(notifier.activeSubscriptionCount));

  return notifier;
}

/** Lazily construct (and memoize) the notifier singleton. */
export function getRunChangeNotifier(): RunChangeNotifier {
  return singleton("runChangeNotifier", initializeRunChangeNotifier);
}

/** Whether the notifier subsystem is enabled for this process. */
export function isRunChangeNotifierEnabled(): boolean {
  return nativeBackendEnabled;
}

/** Fire-and-forget publish of a run-changed record. No-op (and no notifier construction)
 * when disabled, so publish sites can call it unconditionally. */
export function publishChangeRecord(input: ChangeRecordInput): void {
  if (!nativeBackendEnabled) {
    return;
  }
  getRunChangeNotifier().publish(input);
}

export function publishManyChangeRecords(inputs: ChangeRecordInput[]): void {
  if (!nativeBackendEnabled) {
    return;
  }
  getRunChangeNotifier().publishMany(inputs);
}
