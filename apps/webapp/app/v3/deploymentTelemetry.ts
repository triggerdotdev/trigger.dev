import { BuildServerMetadata } from "@trigger.dev/core/v3";

// Attribute names for the deployment telemetry events (see
// DEPLOYMENT_TELEMETRY_ATTRIBUTES.md next to this file). This module is the single owner of these names — Axiom
// queries, dashboards, and monitors reference them, so treat renames as
// breaking changes.
export const DeploymentTelemetryAttributes = {
  ORG_ID: "$trigger.org.id",
  PROJECT_ID: "$trigger.project.id",
  PROJECT_REF: "$trigger.project.ref",
  ENV_ID: "$trigger.env.id",
  ENV_TYPE: "$trigger.env.type",
  DEPLOYMENT_ID: "deployment.id",
  VERSION: "deployment.version",
  STATUS: "deployment.status",
  SUCCESS: "deployment.success",
  BUILD_PATH: "deployment.build_path",
  WORKER_TYPE: "deployment.worker_type",
  RUNTIME: "deployment.runtime",
  RUNTIME_VERSION: "deployment.runtime_version",
  CLI_VERSION: "deployment.cli_version",
  TRIGGERED_VIA: "deployment.triggered_via",
  COMMIT_SHA: "deployment.commit_sha",
  ERROR_NAME: "deployment.error.name",
  ERROR_MESSAGE: "deployment.error.message",
  CANCELED_REASON: "deployment.canceled_reason",
  DURATION_TOTAL_MS: "deployment.duration.total_ms",
  DURATION_QUEUE_MS: "deployment.duration.queue_ms",
  DURATION_INSTALL_MS: "deployment.duration.install_ms",
  DURATION_BUILDING_MS: "deployment.duration.building_ms",
  DURATION_DEPLOYING_MS: "deployment.duration.deploying_ms",
} as const;

export type DeploymentBuildPath = "local_bundle" | "native" | "depot";

/**
 * Classifies which build path produced a deployment, from its persisted
 * metadata. Everything that is not a native-build-server deployment falls into
 * the depot bucket — including rare `--local-build` deploys, whose flag is not
 * persisted. `externalBuildData` is NOT usable as a depot signal: init writes a
 * placeholder (`"-"` fields) for every path.
 */
export function deriveBuildPath(buildServerMetadata: unknown): DeploymentBuildPath {
  const metadata = BuildServerMetadata.safeParse(buildServerMetadata);

  if (metadata.success && metadata.data.isNativeBuild) {
    return metadata.data.fromBundle ? "local_bundle" : "native";
  }

  return "depot";
}

export type DeploymentTimestamps = {
  createdAt: Date;
  startedAt?: Date | null;
  installedAt?: Date | null;
  builtAt?: Date | null;
};

export type DeploymentDurations = {
  totalMs: number;
  queueMs?: number;
  installMs?: number;
  buildingMs?: number;
  deployingMs?: number;
};

/**
 * Derives per-phase durations from the persisted timestamp chain
 * (createdAt → startedAt → installedAt → builtAt → terminal). Chains are
 * path-shaped: depot never sets installedAt (the /progress route is
 * build-server-only) and PENDING-skipping deploys have queue ≈ 0 — each phase
 * is emitted only when both of its boundary timestamps exist and are ordered.
 */
export function deriveDeploymentDurations(
  timestamps: DeploymentTimestamps,
  terminalAt: Date
): DeploymentDurations {
  const { createdAt, startedAt, installedAt, builtAt } = timestamps;
  const buildingFrom = installedAt ?? startedAt;

  return {
    totalMs: Math.max(terminalAt.getTime() - createdAt.getTime(), 0),
    queueMs: msBetween(createdAt, startedAt),
    installMs: msBetween(startedAt, installedAt),
    buildingMs: msBetween(buildingFrom, builtAt),
    deployingMs: msBetween(builtAt, terminalAt),
  };
}

function msBetween(from?: Date | null, to?: Date | null): number | undefined {
  if (!from || !to) return undefined;
  const ms = to.getTime() - from.getTime();
  return ms >= 0 ? ms : undefined;
}
