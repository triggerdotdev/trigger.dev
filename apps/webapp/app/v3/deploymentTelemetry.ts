import { BuildServerMetadata } from "@trigger.dev/core/v3";

/**
 * Attribute names for the `deployment.finished` and `deployment.initialized`
 * telemetry events (emitted by services/recordDeploymentFinished.server.ts).
 * This module is the single owner of these names — external queries,
 * dashboards, and monitors reference them, so treat renames as breaking.
 *
 * Query gotchas: dedup with `arg_max(_time, *) by deployment.id` (job retries
 * can double-emit); the span's `_time` is the deployment's createdAt, so a
 * TIMED_OUT event lands backdated by up to the full deploy timeout — monitor
 * windows must exceed it; phase durations are omitted (not zero) when a
 * boundary timestamp is missing, and `total_ms` excludes local-bundle's
 * pre-init client work (esbuild + upload) until the CLI reports timings.
 */
export const DeploymentTelemetryAttributes = {
  ORG_ID: "$trigger.org.id",
  PROJECT_ID: "$trigger.project.id",
  // Project external ref ("proj_…")
  PROJECT_REF: "$trigger.project.ref",
  ENV_ID: "$trigger.env.id",
  // PRODUCTION / STAGING / PREVIEW / DEVELOPMENT
  ENV_TYPE: "$trigger.env.type",
  // Deployment friendly id — the dedup key
  DEPLOYMENT_ID: "deployment.id",
  VERSION: "deployment.version",
  // finished: terminal status; initialized: initial status (PENDING/BUILDING)
  STATUS: "deployment.status",
  // status === DEPLOYED; CANCELED is excluded from failure rates
  SUCCESS: "deployment.success",
  // depot / native / native_local_bundle (see deriveBuildPath)
  BUILD_PATH: "deployment.build_path",
  // V1 / MANAGED (run engine)
  WORKER_TYPE: "deployment.worker_type",
  RUNTIME: "deployment.runtime",
  // Set at indexing; null for pre-index failures
  RUNTIME_VERSION: "deployment.runtime_version",
  // From x-trigger-cli-version at init; null for pre-column history
  CLI_VERSION: "deployment.cli_version",
  TRIGGERED_VIA: "deployment.triggered_via",
  COMMIT_SHA: "deployment.commit_sha",
  // error.* only on FAILED/TIMED_OUT; CANCELED uses canceled_reason
  ERROR_NAME: "deployment.error.name",
  ERROR_MESSAGE: "deployment.error.message",
  CANCELED_REASON: "deployment.canceled_reason",
  // createdAt → terminal (also the span's own duration)
  DURATION_TOTAL_MS: "deployment.duration.total_ms",
  // createdAt → startedAt; ≈0 when created directly in BUILDING (depot)
  DURATION_QUEUE_MS: "deployment.duration.queue_ms",
  // startedAt → installedAt; build-server paths only (depot never sets it)
  DURATION_INSTALL_MS: "deployment.duration.install_ms",
  // (installedAt ?? startedAt) → builtAt
  DURATION_BUILDING_MS: "deployment.duration.building_ms",
  // builtAt → terminal; for depot dominated by the server-side registry push
  DURATION_DEPLOYING_MS: "deployment.duration.deploying_ms",
} as const;

export type DeploymentBuildPath = "native_local_bundle" | "native" | "depot";

/**
 * Everything that is not a native-build-server deployment falls into the depot
 * bucket, including rare `--local-build` deploys (their flag is not persisted).
 * `externalBuildData` is NOT a usable depot signal: init writes a placeholder
 * for every path.
 */
export function deriveBuildPath(buildServerMetadata: unknown): DeploymentBuildPath {
  const metadata = BuildServerMetadata.safeParse(buildServerMetadata);

  if (metadata.success && metadata.data.isNativeBuild) {
    return metadata.data.fromBundle ? "native_local_bundle" : "native";
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
 * Timestamp chains are path-shaped (e.g. depot never sets installedAt), so
 * each phase is derived only when both of its boundary timestamps exist and
 * are ordered.
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
