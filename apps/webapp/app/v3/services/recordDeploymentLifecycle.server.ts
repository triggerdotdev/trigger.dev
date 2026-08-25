import { ROOT_CONTEXT, SpanStatusCode } from "@opentelemetry/api";
import { type WorkerDeployment, type WorkerDeploymentStatus } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { SEMINTATTRS_FORCE_RECORDING, tracer } from "~/v3/tracer.server";
import {
  DeploymentTelemetryAttributes as ATTRS,
  deriveBuildPath,
  deriveDeploymentDurations,
} from "~/v3/deploymentTelemetry";

type TerminalDeploymentStatus = Extract<
  WorkerDeploymentStatus,
  "DEPLOYED" | "FAILED" | "TIMED_OUT" | "CANCELED"
>;

type LifecycleDeployment = Pick<
  WorkerDeployment,
  | "friendlyId"
  | "version"
  | "type"
  | "status"
  | "createdAt"
  | "startedAt"
  | "installedAt"
  | "builtAt"
  | "deployedAt"
  | "failedAt"
  | "canceledAt"
  | "canceledReason"
  | "buildServerMetadata"
  | "errorData"
  | "runtime"
  | "runtimeVersion"
  | "cliVersion"
  | "triggeredVia"
  | "commitSHA"
>;

type EnvironmentInfo = {
  organizationId?: string;
  projectId?: string;
  projectRef?: string;
  environmentId?: string;
  environmentType?: string;
};

/**
 * Records a deployment's terminal transition as a single wide
 * `deployment.lifecycle` span, backdated to span the deployment's real
 * lifetime (createdAt → terminal) and carrying per-phase durations as
 * attributes. This is THE per-deployment analytics event: build-path
 * comparison dashboards and monitors are built on it (see
 * ../deploymentTelemetry.ts and DEPLOYMENT_TELEMETRY_ATTRIBUTES.md for the attribute contract).
 *
 * Call exactly once per terminal transition, only after a guarded status
 * write confirmed this caller won the transition. Emitted on ROOT_CONTEXT
 * with forceRecording so the trace sampler can never drop it. Never throws.
 */
export function recordDeploymentLifecycle(params: {
  status: TerminalDeploymentStatus;
  deployment: LifecycleDeployment;
  environment: EnvironmentInfo;
  reason?: string;
}): void {
  try {
    const { status, deployment, environment, reason } = params;

    const isFailure = status === "FAILED" || status === "TIMED_OUT";
    const terminalAt =
      deployment.deployedAt ?? deployment.failedAt ?? deployment.canceledAt ?? new Date();
    const durations = deriveDeploymentDurations(deployment, terminalAt);
    const errorData = parseErrorData(deployment.errorData);

    const span = tracer.startSpan(
      "deployment.lifecycle",
      {
        startTime: deployment.createdAt,
        attributes: {
          [SEMINTATTRS_FORCE_RECORDING]: true,
          [ATTRS.ORG_ID]: environment.organizationId,
          [ATTRS.PROJECT_ID]: environment.projectId,
          [ATTRS.PROJECT_REF]: environment.projectRef,
          [ATTRS.ENV_ID]: environment.environmentId,
          [ATTRS.ENV_TYPE]: environment.environmentType,
          [ATTRS.DEPLOYMENT_ID]: deployment.friendlyId,
          [ATTRS.VERSION]: deployment.version,
          [ATTRS.STATUS]: status,
          [ATTRS.SUCCESS]: status === "DEPLOYED",
          [ATTRS.BUILD_PATH]: deriveBuildPath(deployment.buildServerMetadata),
          [ATTRS.WORKER_TYPE]: deployment.type,
          [ATTRS.RUNTIME]: deployment.runtime ?? undefined,
          [ATTRS.RUNTIME_VERSION]: deployment.runtimeVersion ?? undefined,
          [ATTRS.CLI_VERSION]: deployment.cliVersion ?? undefined,
          [ATTRS.TRIGGERED_VIA]: deployment.triggeredVia ?? undefined,
          [ATTRS.COMMIT_SHA]: deployment.commitSHA ?? undefined,
          [ATTRS.ERROR_NAME]: isFailure ? errorData?.name : undefined,
          [ATTRS.ERROR_MESSAGE]: isFailure ? reason ?? errorData?.message : undefined,
          [ATTRS.CANCELED_REASON]: deployment.canceledReason ?? undefined,
          [ATTRS.DURATION_TOTAL_MS]: durations.totalMs,
          [ATTRS.DURATION_QUEUE_MS]: durations.queueMs,
          [ATTRS.DURATION_INSTALL_MS]: durations.installMs,
          [ATTRS.DURATION_BUILDING_MS]: durations.buildingMs,
          [ATTRS.DURATION_DEPLOYING_MS]: durations.deployingMs,
        },
      },
      ROOT_CONTEXT
    );

    // CANCELED is deliberately not an error: it is excluded from failure
    // rates and tracked as its own volume.
    if (isFailure) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: reason ?? errorData?.message,
      });
    }

    span.end(terminalAt);
  } catch (error) {
    logger.debug("recordDeploymentLifecycle failed", {
      deploymentFriendlyId: params.deployment.friendlyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Records a deployment's creation as a zero-duration `deployment.initialized`
 * event, the funnel counterpart to `deployment.lifecycle`: an initialized
 * deployment with no lifecycle event after a few hours is either stuck
 * non-terminal or hit an emission bug. Never throws.
 */
export function recordDeploymentInitialized(params: {
  deployment: Pick<
    WorkerDeployment,
    | "friendlyId"
    | "version"
    | "type"
    | "status"
    | "createdAt"
    | "buildServerMetadata"
    | "runtime"
    | "cliVersion"
    | "triggeredVia"
  >;
  environment: EnvironmentInfo;
}): void {
  try {
    const { deployment, environment } = params;

    const span = tracer.startSpan(
      "deployment.initialized",
      {
        startTime: deployment.createdAt,
        attributes: {
          [SEMINTATTRS_FORCE_RECORDING]: true,
          [ATTRS.ORG_ID]: environment.organizationId,
          [ATTRS.PROJECT_ID]: environment.projectId,
          [ATTRS.PROJECT_REF]: environment.projectRef,
          [ATTRS.ENV_ID]: environment.environmentId,
          [ATTRS.ENV_TYPE]: environment.environmentType,
          [ATTRS.DEPLOYMENT_ID]: deployment.friendlyId,
          [ATTRS.VERSION]: deployment.version,
          [ATTRS.STATUS]: deployment.status,
          [ATTRS.BUILD_PATH]: deriveBuildPath(deployment.buildServerMetadata),
          [ATTRS.WORKER_TYPE]: deployment.type,
          [ATTRS.RUNTIME]: deployment.runtime ?? undefined,
          [ATTRS.CLI_VERSION]: deployment.cliVersion ?? undefined,
          [ATTRS.TRIGGERED_VIA]: deployment.triggeredVia ?? undefined,
        },
      },
      ROOT_CONTEXT
    );

    span.end(deployment.createdAt);
  } catch (error) {
    logger.debug("recordDeploymentInitialized failed", {
      deploymentFriendlyId: params.deployment.friendlyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseErrorData(errorData: unknown): { name?: string; message?: string } | undefined {
  if (!errorData || typeof errorData !== "object") return undefined;
  const record = errorData as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}
