import type {
  EnvironmentType,
  MachinePreset,
  PlacementTag,
  RunAnnotations,
} from "@trigger.dev/core/v3";

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
  // Whether CRIU checkpoint/restore is enabled for this deployment. Only when
  // checkpointing is enabled do node-24+ pods need the io_uring-blocking seccomp
  // profile (io_uring FDs can't be checkpointed). Self-hosters without
  // checkpointing don't need it - and don't have the profile on their nodes.
  checkpointsEnabled?: boolean;
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
  // Timing context (populated by supervisor handler, included in wide event)
  dequeueResponseMs?: number;
  pollingIntervalMs?: number;
  warmStartCheckMs?: number;
  // identifiers
  envId: string;
  envType: EnvironmentType;
  orgId: string;
  projectId: string;
  deploymentFriendlyId: string;
  deploymentVersion: string;
  // Canonical runtime identifier (e.g. "node", "node-22", "node-24"). Used to
  // scope the io_uring-blocking seccomp profile to runtimes that require it.
  runtime?: string;
  runId: string;
  runFriendlyId: string;
  snapshotId: string;
  snapshotFriendlyId: string;
  // Trace context for OTel span emission (W3C format: { traceparent: "00-...", tracestate?: "..." })
  traceContext?: Record<string, unknown>;
  annotations?: RunAnnotations;
  // private networking
  hasPrivateLink?: boolean;
}
