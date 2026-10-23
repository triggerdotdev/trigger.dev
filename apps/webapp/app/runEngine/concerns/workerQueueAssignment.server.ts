import { formatWorkerQueue, WORKER_QUEUE_VERSION } from "@trigger.dev/core/v3/workers";
import {
  FEATURE_FLAG,
  FeatureFlagCatalog,
  WorkerQueueEnvironmentOverride,
} from "~/v3/featureFlags";
import type { WorkerGroupRegionRow } from "~/v3/workerRegions.server";
import { workerQueueForRun } from "./workerQueueSplit.server";

export function environmentWorkerQueueOverride({
  orgFeatureFlags,
  environmentId,
  environmentType,
}: {
  orgFeatureFlags: Record<string, unknown> | null | undefined;
  environmentId: string;
  environmentType: string;
}): WorkerQueueEnvironmentOverride {
  if (environmentType === "DEVELOPMENT") {
    return {};
  }

  const overrides = orgFeatureFlags?.[FEATURE_FLAG.workerQueueEnvironmentOverrides];
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return {};
  }

  const entries = overrides as Record<string, unknown>;
  const idEntry = entries[environmentId];
  const typeEntry = entries[environmentType];
  const byId =
    idEntry === undefined ? undefined : WorkerQueueEnvironmentOverride.safeParse(idEntry).data;
  const byType =
    typeEntry === undefined ? undefined : WorkerQueueEnvironmentOverride.safeParse(typeEntry).data;

  return {
    compat: byId?.compat ?? byType?.compat,
    channel: byId?.channel ?? byType?.channel,
  };
}

export function workerQueueForBirth({
  workerQueue,
  region,
  envType,
  orgFeatureFlags,
  environmentOverride,
  v2Enabled,
  splitEnabled,
  workerGroups,
  rootTriggerSource,
  templateFallback,
  compute,
  anyCompatAllowed,
}: {
  workerQueue: string;
  region: string | undefined;
  envType: string;
  orgFeatureFlags: Record<string, unknown> | null | undefined;
  environmentOverride: WorkerQueueEnvironmentOverride;
  v2Enabled: boolean;
  splitEnabled: boolean;
  workerGroups: readonly Pick<WorkerGroupRegionRow, "masterQueue" | "workloadType">[];
  rootTriggerSource: string | undefined;
  /** The run stays off compute because its deployment has no template key. */
  templateFallback?: boolean;
  /** The run moved to its region's compute backing, so it defaults to compute in a mixed group. */
  compute?: boolean;
  /** The org is compute-enabled and the deployment has a template, so either runtime can run it. */
  anyCompatAllowed: boolean;
}): string {
  if (envType === "DEVELOPMENT") {
    return workerQueue;
  }

  // An unknown queue (e.g. cold registry) has no trustworthy region or runtime, so stay legacy.
  const group = workerGroups.find((group) => group.masterQueue === workerQueue);
  if (!v2Enabled || !group) {
    return workerQueueForRun({ workerQueue, rootTriggerSource, splitEnabled });
  }

  const defaultCompatibility =
    compute || group.workloadType === "MICROVM" ? "compute" : "container";
  const compatibility = FeatureFlagCatalog[FEATURE_FLAG.workerQueueCompatibility].safeParse(
    environmentOverride.compat ??
      orgFeatureFlags?.[FEATURE_FLAG.workerQueueCompatibility] ??
      defaultCompatibility
  );
  const channel = FeatureFlagCatalog[FEATURE_FLAG.workerQueueChannel].safeParse(
    environmentOverride.channel ?? orgFeatureFlags?.[FEATURE_FLAG.workerQueueChannel] ?? "stable"
  );
  const parsed = compatibility.success ? compatibility.data : defaultCompatibility;
  // An `any` item goes to whichever runtime takes it first, so only a run compute can start is one.
  const compat = parsed === "any" && !anyCompatAllowed ? "container" : parsed;
  // Match the dequeue fallback: container consumers take only the stable channel.
  const keylessOnContainers = templateFallback && compat === "container";
  const assignment = formatWorkerQueue({
    region: region ?? workerQueue,
    version: WORKER_QUEUE_VERSION,
    class: "ondemand",
    phase: "fresh",
    compat,
    channel: !keylessOnContainers && channel.success ? channel.data : "stable",
  });

  return workerQueueForRun({
    workerQueue: assignment,
    rootTriggerSource,
    splitEnabled,
    version: WORKER_QUEUE_VERSION,
  });
}
