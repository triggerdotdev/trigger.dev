import { formatWorkerQueue, WORKER_QUEUE_VERSION } from "@trigger.dev/core/v3/workers";
import { FEATURE_FLAG, FeatureFlagCatalog } from "~/v3/featureFlags";
import type { WorkerGroupRegionRow } from "~/v3/workerRegions.server";
import { workerQueueForRun } from "./workerQueueSplit.server";

export function workerQueueForBirth({
  workerQueue,
  region,
  envType,
  orgFeatureFlags,
  globalDefault,
  workerGroups,
  rootTriggerSource,
  splitEnabled,
}: {
  workerQueue: string;
  region: string | undefined;
  envType: string;
  orgFeatureFlags: Record<string, unknown> | null | undefined;
  globalDefault: boolean;
  workerGroups: readonly Pick<WorkerGroupRegionRow, "masterQueue" | "workloadType">[];
  rootTriggerSource: string | undefined;
  splitEnabled: boolean;
}): string {
  const enabled = orgFeatureFlags?.[FEATURE_FLAG.workerQueueV2Enabled];
  const useV2 =
    envType !== "DEVELOPMENT" && (typeof enabled === "boolean" ? enabled : globalDefault);

  // An unknown queue (e.g. cold registry) has no trustworthy region or runtime, so stay legacy.
  const group = workerGroups.find((group) => group.masterQueue === workerQueue);
  if (!useV2 || !group) {
    return workerQueueForRun({ workerQueue, rootTriggerSource, splitEnabled });
  }

  const defaultCompatibility = group.workloadType === "MICROVM" ? "compute" : "container";
  const compatibility = FeatureFlagCatalog[FEATURE_FLAG.workerQueueCompatibility].safeParse(
    orgFeatureFlags?.[FEATURE_FLAG.workerQueueCompatibility] ?? defaultCompatibility
  );
  const channel = FeatureFlagCatalog[FEATURE_FLAG.workerQueueChannel].safeParse(
    orgFeatureFlags?.[FEATURE_FLAG.workerQueueChannel] ?? "stable"
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
