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
}): string {
  if (envType === "DEVELOPMENT") {
    return workerQueue;
  }

  // An unknown queue (e.g. cold registry) has no trustworthy region or runtime, so stay legacy.
  const group = workerGroups.find((group) => group.masterQueue === workerQueue);
  if (!v2Enabled || !group) {
    return workerQueueForRun({ workerQueue, rootTriggerSource, splitEnabled });
  }

  const defaultCompatibility = group.workloadType === "MICROVM" ? "compute" : "container";
  const compatibility = FeatureFlagCatalog[FEATURE_FLAG.workerQueueCompatibility].safeParse(
    environmentOverride.compat ??
      orgFeatureFlags?.[FEATURE_FLAG.workerQueueCompatibility] ??
      defaultCompatibility
  );
  const channel = FeatureFlagCatalog[FEATURE_FLAG.workerQueueChannel].safeParse(
    environmentOverride.channel ?? orgFeatureFlags?.[FEATURE_FLAG.workerQueueChannel] ?? "stable"
  );
  const assignment = formatWorkerQueue({
    region: region ?? workerQueue,
    version: WORKER_QUEUE_VERSION,
    class: "ondemand",
    phase: "fresh",
    compat: compatibility.success ? compatibility.data : defaultCompatibility,
    channel: channel.success ? channel.data : "stable",
  });

  return workerQueueForRun({
    workerQueue: assignment,
    rootTriggerSource,
    splitEnabled,
    version: WORKER_QUEUE_VERSION,
  });
}
