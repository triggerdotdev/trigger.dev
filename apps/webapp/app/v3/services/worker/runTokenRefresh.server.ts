import { getMeter } from "@internal/tracing";
import type { ExecutionResult, TaskRunExecutionStatus } from "@trigger.dev/core/v3";
import {
  RUN_TOKEN_INSTALL_FAILURE_REASONS,
  RUN_TOKEN_REFRESH_BEFORE_EXPIRY_SECONDS,
  RUN_TOKEN_REFRESH_TRIGGERS,
  type RunTokenHeartbeatReport,
  type RunTokenRefreshTrigger,
} from "@trigger.dev/core/v3/workers";
import type { PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { mintRunToken, runTokenInjectionEnabled } from "~/services/oidc/runToken.server";
import { singleton } from "~/utils/singleton";

// Statuses in which the heartbeating runner still owns a live attempt, including the restore
// window before it continues.
const LIVE_ATTEMPT_STATUSES: ReadonlySet<TaskRunExecutionStatus> = new Set<TaskRunExecutionStatus>([
  "PENDING_EXECUTING",
  "EXECUTING",
  "EXECUTING_WITH_WAITPOINTS",
  "QUEUED_EXECUTING",
]);

const REMAINING_LIFETIME_BUCKETS_SECONDS = [0, 60, 300, 600, 900, 1800, 2700, 3600];

const ISSUE_ERROR_REASONS = ["lookup_error", "sign_error"] as const;

type IssueOutcome =
  | { result: "success"; reason: "none"; token: string }
  | {
      result: "skipped";
      reason: "injection_disabled" | "stale_snapshot" | "not_executing" | "identity_mismatch";
    }
  | { result: "error"; reason: (typeof ISSUE_ERROR_REASONS)[number] };

// Names and label values are relied on by internal dashboards and monitors. Labels stay bounded.
const telemetry = singleton("runTokenRefreshTelemetry", () => {
  const meter = getMeter("run-token-refresh");
  const issued = meter.createCounter("run_token.refresh.issued", {
    description: "Due run-token refresh requests handled by the webapp. Not delivery success",
  });
  const installations = meter.createCounter("run_token.refresh.installations", {
    description: "Runner-reported installs of refreshed run tokens into the task process",
  });

  // Export the rare failure series from zero, so a rate query sees a process's first failure.
  for (const trigger of RUN_TOKEN_REFRESH_TRIGGERS) {
    for (const reason of ISSUE_ERROR_REASONS) issued.add(0, { trigger, result: "error", reason });
    for (const reason of RUN_TOKEN_INSTALL_FAILURE_REASONS) {
      installations.add(0, { trigger, result: "failure", reason });
    }
  }

  return {
    issued,
    installations,
    remainingLifetime: meter.createHistogram("run_token.refresh.remaining_lifetime_seconds", {
      description:
        "Remaining lifetime of the run token installed in the task process, per heartbeat",
      unit: "s",
      advice: { explicitBucketBoundaries: REMAINING_LIFETIME_BUCKETS_SECONDS },
    }),
  };
});

export type FindRunForRefresh = (runId: string) => Promise<{
  taskIdentifier: string;
  runtimeEnvironmentId: string;
  lockedById: string | null;
} | null>;

export type RunTokenRefreshRequest = {
  report: RunTokenHeartbeatReport | undefined;
  /** The engine's heartbeat result, i.e. the run's latest snapshot. */
  heartbeat: ExecutionResult;
  snapshotFriendlyId: string;
  /** Verified workload environment, when the supervisor forwarded one. */
  environmentId?: string;
  findRun: FindRunForRefresh;
  replica: PrismaClientOrTransaction;
  now?: Date;
};

/**
 * Records the runner's installed-token telemetry and, only when its token is due, mints a
 * replacement. Identity comes from the run's server-side state, never from the runner's token.
 */
export async function refreshRunTokenOnHeartbeat(
  request: RunTokenRefreshRequest
): Promise<string | undefined> {
  const { report } = request;
  if (!report) return undefined;

  const { trigger } = report;
  const remainingSeconds = report.expiresAt - (request.now ?? new Date()).getTime() / 1_000;
  // OTel JS drops negative histogram values; zero stands for expired.
  telemetry.remainingLifetime.record(Math.max(0, remainingSeconds), { trigger });

  if (report.installation) {
    const { installation } = report;
    telemetry.installations.add(1, {
      trigger: installation.trigger,
      result: installation.result,
      reason: installation.result === "success" ? "none" : installation.reason,
    });
  }

  if (remainingSeconds > RUN_TOKEN_REFRESH_BEFORE_EXPIRY_SECONDS) return undefined;

  const outcome = await issue(request, trigger);
  telemetry.issued.add(1, { trigger, result: outcome.result, reason: outcome.reason });
  return outcome.result === "success" ? outcome.token : undefined;
}

async function issue(
  { heartbeat, snapshotFriendlyId, environmentId, findRun, replica }: RunTokenRefreshRequest,
  trigger: RunTokenRefreshTrigger
): Promise<IssueOutcome> {
  if (!env.RUN_TOKEN_ISSUER_URL) return { result: "skipped", reason: "injection_disabled" };
  // Legacy workload calls carry no verified tenant scope, even in enforcement mode.
  if (!environmentId) return { result: "skipped", reason: "identity_mismatch" };

  const { snapshot, run } = heartbeat;
  if (snapshot.friendlyId !== snapshotFriendlyId) {
    return { result: "skipped", reason: "stale_snapshot" };
  }
  if (!LIVE_ATTEMPT_STATUSES.has(snapshot.executionStatus)) {
    return { result: "skipped", reason: "not_executing" };
  }
  if (!run.attemptNumber) return { result: "skipped", reason: "identity_mismatch" };

  let identity;
  try {
    identity = await loadIdentity(run.id, findRun, replica);
  } catch (error) {
    logger.warn("Run token refresh lookup failed", {
      runId: run.friendlyId,
      trigger,
      error: error instanceof Error ? error.message : String(error),
    });
    return { result: "error", reason: "lookup_error" };
  }

  if (!identity || identity.environment.id !== environmentId) {
    return { result: "skipped", reason: "identity_mismatch" };
  }

  const { environment, taskIdentifier, deploymentFriendlyId } = identity;
  if (!runTokenInjectionEnabled(environment.organization.featureFlags)) {
    return { result: "skipped", reason: "injection_disabled" };
  }

  try {
    const token = await mintRunToken({
      organizationId: environment.organizationId,
      projectId: environment.projectId,
      environmentId: environment.id,
      environmentType: environment.type,
      runFriendlyId: run.friendlyId,
      attemptNumber: run.attemptNumber,
      taskIdentifier,
      deploymentFriendlyId,
    });
    return { result: "success", reason: "none", token };
  } catch (error) {
    logger.warn("Run token refresh signing failed", {
      runId: run.friendlyId,
      trigger,
      error: error instanceof Error ? error.message : String(error),
    });
    return { result: "error", reason: "sign_error" };
  }
}

// Runs once per due refresh (roughly once per token lifetime per live attempt), not per heartbeat.
async function loadIdentity(
  runId: string,
  findRun: FindRunForRefresh,
  replica: PrismaClientOrTransaction
) {
  const run = await findRun(runId);
  if (!run) return undefined;

  const [environment, lockedTask] = await Promise.all([
    replica.runtimeEnvironment.findFirst({
      where: { id: run.runtimeEnvironmentId },
      select: {
        id: true,
        type: true,
        organizationId: true,
        projectId: true,
        organization: { select: { featureFlags: true } },
      },
    }),
    run.lockedById
      ? replica.backgroundWorkerTask.findFirst({
          where: { id: run.lockedById },
          select: { worker: { select: { deployment: { select: { friendlyId: true } } } } },
        })
      : undefined,
  ]);
  if (!environment) return undefined;

  return {
    environment,
    taskIdentifier: run.taskIdentifier,
    deploymentFriendlyId: lockedTask?.worker.deployment?.friendlyId,
  };
}
