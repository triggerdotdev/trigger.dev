import type { EnvironmentType, MachinePreset, PlacementTag } from "@trigger.dev/core/v3";

export interface WorkloadManagerOptions {
  workloadApiProtocol: "http" | "https";
  workloadApiDomain?: string; // If unset, will use orchestrator-specific default
  workloadApiPort: number;
  warmStartUrl?: string;
  metadataUrl?: string;
  imagePullSecrets?: string[];
  heartbeatIntervalSeconds?: number;
  snapshotPollIntervalSeconds?: number;
  additionalEnvVars?: Record<string, string>;
  dockerAutoremove?: boolean;
}

export interface WorkloadManager {
  create: (opts: WorkloadManagerCreateOptions) => Promise<unknown>;
}

export interface WorkloadManagerCreateOptions {
  image: string;
  machine: MachinePreset;
  version: string;
  nextAttemptNumber?: number;
  dequeuedAt: Date;
  placementTags?: PlacementTag[];
  // identifiers
  envId: string;
  envType: EnvironmentType;
  orgId: string;
  projectId: string;
  deploymentFriendlyId: string;
  deploymentVersion: string;
  runId: string;
  runFriendlyId: string;
  snapshotId: string;
  snapshotFriendlyId: string;
}
