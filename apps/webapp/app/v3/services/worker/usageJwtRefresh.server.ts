import type { RunStore } from "@internal/run-store";
import { getMeter } from "@internal/tracing";
import {
  fromFriendlyId,
  type TaskRunContext,
  type TaskRunExecutionStatus,
} from "@trigger.dev/core/v3";
import {
  USAGE_JWT_REFRESH_BEFORE_EXPIRY_SECONDS,
  type WorkerApiRunHeartbeatRequestBody,
} from "@trigger.dev/core/v3/workers";
import { singleton } from "~/utils/singleton";
import { meteringClaims } from "~/v3/utils/meteringClaims.server";

type EnvironmentIdentity = { id: string; organizationId: string; projectId: string };

const LIVE_ATTEMPT_STATUSES: ReadonlySet<TaskRunExecutionStatus> = new Set<TaskRunExecutionStatus>([
  "PENDING_EXECUTING",
  "EXECUTING",
  "EXECUTING_WITH_WAITPOINTS",
  "QUEUED_EXECUTING",
]);

const REFUSAL_REASONS = ["missing_identity", "not_owner", "identity_changed"] as const;
type RefusalReason = (typeof REFUSAL_REASONS)[number];

class UsageJwtRefusal extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`Billing JWT refresh refused: ${reason}`);
  }
}

// Names and label values are relied on by internal dashboards and monitors. Labels stay bounded.
const telemetry = singleton("usageJwtRefreshTelemetry", () => {
  const issued = getMeter("usage-jwt-refresh").createCounter("usage_jwt.refresh.issued", {
    description: "Due billing JWT refresh requests handled by the webapp. Not delivery success",
  });
  // Export the failure series from zero, so a rate query sees a process's first failure.
  for (const reason of REFUSAL_REASONS) issued.add(0, { result: "refused", reason });
  issued.add(0, { result: "error", reason: "error" });
  const initial = getMeter("usage-jwt-refresh").createCounter("usage_jwt.initial", {
    description: "Billing credential kind handed out at attempt start",
  });
  initial.add(0, { kind: "legacy_unverified" });
  return { issued, initial };
});

export type InitialUsageAuth =
  | "control_plane"
  | "legacy_runner"
  | "legacy_root_key"
  | "legacy_unverified";

/**
 * Which billing credential an attempt starts with. A run holding the root key keeps API-key
 * recovery; only a run without it needs the control plane to renew its credential.
 */
export function initialUsageAuth(opts: {
  supportsUsageJwtRefresh?: boolean;
  verifiedEnvironmentId?: string;
  environmentId: string;
  hasRootKey: boolean;
}): InitialUsageAuth {
  if (!opts.supportsUsageJwtRefresh) return "legacy_runner";
  if (opts.hasRootKey) return "legacy_root_key";
  if (opts.verifiedEnvironmentId !== opts.environmentId) return "legacy_unverified";
  return "control_plane";
}

export function countInitialUsageAuth(kind: InitialUsageAuth) {
  telemetry.initial.add(1, { kind });
}

type RefreshOptions = {
  report: WorkerApiRunHeartbeatRequestBody["usageJwt"];
  runId: string;
  snapshotId: string;
  workerId: string;
  runnerId?: string;
  environmentId?: string;
  projectId?: string;
  store: Pick<RunStore, "findLatestExecutionSnapshot" | "findRun">;
  resolveContext: (runId: string) => Promise<TaskRunContext>;
  sign: (environment: EnvironmentIdentity, claims: Record<string, string>) => Promise<string>;
  now?: number;
};

/** Mints a replacement only when the reported credential is due. Throws when refused or failed. */
export async function refreshUsageJwtOnHeartbeat(
  opts: RefreshOptions
): Promise<string | undefined> {
  const { report } = opts;
  if (!report) return undefined;
  if (
    report.expiresAt - (opts.now ?? Date.now()) / 1_000 >
    USAGE_JWT_REFRESH_BEFORE_EXPIRY_SECONDS
  ) {
    return undefined;
  }

  try {
    const token = await issue(opts, report);
    telemetry.issued.add(1, { result: "success", reason: "none" });
    return token;
  } catch (error) {
    const refused = error instanceof UsageJwtRefusal;
    telemetry.issued.add(1, {
      result: refused ? "refused" : "error",
      reason: refused ? error.reason : "error",
    });
    throw error;
  }
}

async function issue(
  opts: RefreshOptions,
  report: NonNullable<RefreshOptions["report"]>
): Promise<string> {
  if (!opts.environmentId || !opts.runnerId) throw new UsageJwtRefusal("missing_identity");

  const assertOwnership = async () => {
    const snapshot = await opts.store.findLatestExecutionSnapshot(
      opts.runId,
      undefined,
      opts.environmentId
    );
    if (
      !snapshot ||
      !snapshot.isValid ||
      snapshot.id !== opts.snapshotId ||
      snapshot.runId !== opts.runId ||
      snapshot.environmentId !== opts.environmentId ||
      snapshot.workerId !== opts.workerId ||
      snapshot.runnerId !== opts.runnerId ||
      snapshot.attemptNumber !== report.attemptNumber ||
      !LIVE_ATTEMPT_STATUSES.has(snapshot.executionStatus) ||
      (opts.projectId !== undefined && snapshot.projectId !== opts.projectId)
    ) {
      throw new UsageJwtRefusal("not_owner");
    }
    return snapshot;
  };

  const snapshot = await assertOwnership();
  const [context, run] = await Promise.all([
    opts.resolveContext(opts.runId),
    opts.store.findRun(
      { id: opts.runId },
      {
        select: {
          runtimeEnvironmentId: true,
          attemptNumber: true,
          region: true,
          workerQueue: true,
        },
      }
    ),
  ]);
  if (
    !run ||
    run.runtimeEnvironmentId !== snapshot.environmentId ||
    run.attemptNumber !== report.attemptNumber ||
    fromFriendlyId(context.run.id) !== opts.runId ||
    context.environment.id !== snapshot.environmentId ||
    context.organization.id !== snapshot.organizationId ||
    context.project.id !== snapshot.projectId ||
    context.attempt.number !== report.attemptNumber
  ) {
    throw new UsageJwtRefusal("identity_changed");
  }
  // Context resolution can cross stores. Do not sign if the attempt moved during those reads.
  await assertOwnership();

  return opts.sign(
    {
      id: context.environment.id,
      organizationId: context.organization.id,
      projectId: context.project.id,
    },
    {
      ...meteringClaims({
        environmentType: context.environment.type,
        region: run.region,
        workerQueue: run.workerQueue,
      }),
      run_id: opts.runId,
      machine_preset: context.machine.name,
      usage_auth: "control-plane-v1",
      usage_attempt: String(report.attemptNumber),
    }
  );
}
