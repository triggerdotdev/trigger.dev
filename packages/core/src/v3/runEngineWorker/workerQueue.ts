import { z } from "zod/v4";

export const WORKER_QUEUE_VERSION = "v2";
export const SCHEDULED_WORKER_QUEUE_SUFFIX = ":scheduled";

/** The dispatch class of a v2 worker queue. Kept separate from the legacy dequeue class. */
export const WorkerQueueDispatchClass = z.enum(["ondemand", "scheduled"]);
export type WorkerQueueDispatchClass = z.infer<typeof WorkerQueueDispatchClass>;

export const WorkerQueuePhase = z.enum(["fresh", "restore"]);
export type WorkerQueuePhase = z.infer<typeof WorkerQueuePhase>;

export const WorkerQueueCompatibility = z.enum(["any", "container", "compute"]);
export type WorkerQueueCompatibility = z.infer<typeof WorkerQueueCompatibility>;

export const WorkerQueueChannel = z.enum(["stable", "canary"]);
export type WorkerQueueChannel = z.infer<typeof WorkerQueueChannel>;

export const WorkerQueueSubscription = z.strictObject({
  class: WorkerQueueDispatchClass,
  phase: WorkerQueuePhase,
  compat: WorkerQueueCompatibility,
  channel: WorkerQueueChannel,
});
export type WorkerQueueSubscription = z.infer<typeof WorkerQueueSubscription>;

export const MAX_WORKER_QUEUE_SUBSCRIPTIONS =
  WorkerQueueDispatchClass.options.length *
  WorkerQueuePhase.options.length *
  WorkerQueueCompatibility.options.length *
  WorkerQueueChannel.options.length;

export const WorkerQueueSubscriptions = z
  .array(WorkerQueueSubscription)
  .min(1)
  .max(MAX_WORKER_QUEUE_SUBSCRIPTIONS);

export const WeightedWorkerQueueSubscription = WorkerQueueSubscription.extend({
  weight: z.number().finite().min(0).max(1).optional(),
});
export type WeightedWorkerQueueSubscription = z.infer<typeof WeightedWorkerQueueSubscription>;

function subscriptionKey(subscription: WorkerQueueSubscription): string {
  return `${subscription.class}:${subscription.phase}:${subscription.compat}:${subscription.channel}`;
}

export const WeightedWorkerQueueSubscriptions = z
  .array(WeightedWorkerQueueSubscription)
  .min(1)
  .max(MAX_WORKER_QUEUE_SUBSCRIPTIONS)
  .superRefine((subscriptions, ctx) => {
    const identities = new Set<string>();
    let hasPositiveWeight = false;

    for (const [index, subscription] of subscriptions.entries()) {
      const key = subscriptionKey(subscription);
      if (identities.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: "Worker queue subscriptions must have unique identities",
          path: [index],
        });
      }
      identities.add(key);
      hasPositiveWeight ||= (subscription.weight ?? 1) > 0;
    }

    if (!hasPositiveWeight) {
      ctx.addIssue({
        code: "custom",
        message: "At least one worker queue subscription must have a positive weight",
      });
    }
  });
export type WeightedWorkerQueueSubscriptions = z.infer<typeof WeightedWorkerQueueSubscriptions>;

const WorkerQueueRegion = z.string().regex(/^[^:\s]+$/);

export type WorkerQueue =
  | { region: string; version: "legacy"; class: WorkerQueueDispatchClass }
  | ({ region: string; version: typeof WORKER_QUEUE_VERSION } & WorkerQueueSubscription);

export function isV2WorkerQueue(name: string): boolean {
  return name.split(":")[1] === WORKER_QUEUE_VERSION;
}

export function parseWorkerQueue(name: string): WorkerQueue {
  const [rawRegion, versionOrClass, queueClass, phase, compat, channel, ...extra] = name.split(":");
  const region = WorkerQueueRegion.parse(rawRegion);

  if (versionOrClass === undefined) {
    return { region, version: "legacy", class: "ondemand" };
  }

  if (versionOrClass === "scheduled" && queueClass === undefined) {
    return { region, version: "legacy", class: "scheduled" };
  }

  if (versionOrClass !== WORKER_QUEUE_VERSION || extra.length > 0) {
    throw new Error(`Invalid worker queue name: ${name}`);
  }

  const subscription = WorkerQueueSubscription.parse({
    class: queueClass,
    phase,
    compat,
    channel,
  });
  return { region, version: WORKER_QUEUE_VERSION, ...subscription };
}

export function formatWorkerQueue(queue: WorkerQueue): string {
  const region = WorkerQueueRegion.parse(queue.region);

  if (queue.version === "legacy") {
    return queue.class === "scheduled" ? `${region}${SCHEDULED_WORKER_QUEUE_SUFFIX}` : region;
  }

  const subscription = WorkerQueueSubscription.parse({
    class: queue.class,
    phase: queue.phase,
    compat: queue.compat,
    channel: queue.channel,
  });
  const { class: queueClass, phase, compat, channel } = subscription;
  return `${region}:${WORKER_QUEUE_VERSION}:${queueClass}:${phase}:${compat}:${channel}`;
}

export function legacyScheduledWorkerQueue(name: string): string {
  return name.endsWith(SCHEDULED_WORKER_QUEUE_SUFFIX)
    ? name
    : `${name}${SCHEDULED_WORKER_QUEUE_SUFFIX}`;
}

export function restoreWorkerQueue(
  name: string,
  compat: Exclude<WorkerQueueCompatibility, "any">
): string {
  if (!isV2WorkerQueue(name)) {
    return name;
  }

  const queue = parseWorkerQueue(name);
  if (queue.version === "legacy") {
    return name;
  }

  return formatWorkerQueue({ ...queue, phase: "restore", compat });
}

export function scheduledWorkerQueue(name: string): string {
  const queue = parseWorkerQueue(name);
  return formatWorkerQueue({ ...queue, class: "scheduled" });
}
