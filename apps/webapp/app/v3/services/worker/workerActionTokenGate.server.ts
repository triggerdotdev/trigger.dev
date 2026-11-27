import { json } from "@remix-run/server-runtime";
import { WORKER_HEADERS } from "@trigger.dev/core/v3/workers";
import type { AuthenticatedWorkerInstance } from "./workerGroupTokenService.server";
import {
  evaluateWorkerActionToken,
  type CreatedAfterCutoff,
  type VerifiedWorkerActionToken,
  type WorkerActionTokenAction,
  type WorkerActionTokenConfig,
  type WorkerActionTokenMode,
  type WorkerActionTokenRouteAction,
  type WorkerActionTokenVerifier,
} from "./workerActionTokenVerifier.server";

export type WorkerActionTokenWorker = Pick<
  AuthenticatedWorkerInstance,
  "tokenKind" | "workerGroupId" | "name" | "findRunCreatedAt"
>;

export type WorkerActionTokenStartVersion = {
  mode: Exclude<WorkerActionTokenMode, "off">;
  deploymentVersion: string;
};

export type WorkerActionTokenGateResult = {
  environmentId?: string;
  sandboxRunId?: string;
  tokenEnvironmentId?: string;
  startVersion?: WorkerActionTokenStartVersion;
};

export type WorkerActionTokenOutcomeRecord = {
  outcome: string;
  action: WorkerActionTokenAction;
  mode: Exclude<WorkerActionTokenMode, "off">;
  worker: WorkerActionTokenWorker;
  runFriendlyId: string;
  createdAfterCutoff: CreatedAfterCutoff;
};

export type WorkerActionTokenGateArgs = {
  action: WorkerActionTokenRouteAction;
  request: Request;
  worker: WorkerActionTokenWorker;
  runFriendlyId: string;
  environmentId?: string;
  sandboxRunId?: string;
};

export type WorkerActionTokenStartVersionArgs = {
  startVersion: WorkerActionTokenStartVersion;
  lockedVersion: string | null | undefined;
  worker: WorkerActionTokenWorker;
  runFriendlyId: string;
};

export type WorkerActionTokenGate = {
  apply(args: WorkerActionTokenGateArgs): Promise<WorkerActionTokenGateResult>;
  assertStartVersion(args: WorkerActionTokenStartVersionArgs): void;
};

function denied() {
  return json({ error: "Run does not belong to this worker" }, { status: 403 });
}

export function createWorkerActionTokenGate({
  config,
  verifier,
  record,
}: {
  config: WorkerActionTokenConfig;
  verifier: WorkerActionTokenVerifier;
  record: (outcome: WorkerActionTokenOutcomeRecord) => void;
}): WorkerActionTokenGate {
  return {
    async apply({ action, request, worker, runFriendlyId, environmentId, sandboxRunId }) {
      const mode = config.modes[action];
      const versionMode = action === "start" ? config.modes["start_version"] : "off";

      if (mode === "off" && versionMode === "off") {
        return { environmentId, sandboxRunId };
      }

      const rawToken = request.headers.get(WORKER_HEADERS.WORKLOAD_TOKEN) || undefined;
      const token: VerifiedWorkerActionToken | undefined = rawToken
        ? verifier.verify(rawToken)
        : undefined;

      let result: WorkerActionTokenGateResult = { environmentId, sandboxRunId };
      let verified: VerifiedWorkerActionToken | undefined;

      const evaluate = async (
        evaluationAction: WorkerActionTokenAction,
        evaluationMode: Exclude<WorkerActionTokenMode, "off">
      ) => {
        try {
          return await evaluateWorkerActionToken({
            mode: evaluationMode,
            token,
            routeRunFriendlyId: runFriendlyId,
            headerEnvironmentId: environmentId,
            tokenKind: worker.tokenKind,
            cutoffMs: config.cutoffMs,
            loadRunCreatedAt: () => worker.findRunCreatedAt(runFriendlyId),
          });
        } catch (error) {
          record({
            outcome: "lookup_error",
            action: evaluationAction,
            mode: evaluationMode,
            worker,
            runFriendlyId,
            createdAfterCutoff: "unknown",
          });
          if (evaluationMode === "enforce") throw error;
          return undefined;
        }
      };

      const evaluation = mode === "off" ? undefined : await evaluate(action, mode);

      if (mode !== "off" && evaluation) {
        record({
          outcome: evaluation.outcome,
          action,
          mode,
          worker,
          runFriendlyId,
          createdAfterCutoff: evaluation.createdAfterCutoff,
        });

        if (mode === "enforce" && !evaluation.allowed) {
          throw denied();
        }

        verified = evaluation.verified;

        if (mode === "enforce" && verified) {
          const claims = verified.claims;
          result = {
            environmentId: claims.environment_id,
            sandboxRunId: claims.execution_mode === "SANDBOX" ? claims.run : undefined,
            tokenEnvironmentId: claims.environment_id,
          };
        }
      } else if (token && versionMode !== "off") {
        verified = (await evaluate("start_version", versionMode))?.verified;
      }

      if (versionMode !== "off" && verified) {
        result.startVersion = {
          mode: versionMode,
          deploymentVersion: verified.claims.deployment_version,
        };
      }

      return result;
    },

    assertStartVersion({ startVersion, lockedVersion, worker, runFriendlyId }) {
      const outcome =
        lockedVersion === null || lockedVersion === undefined
          ? "version_unknown"
          : lockedVersion === startVersion.deploymentVersion
            ? "verified"
            : "version_mismatch";

      record({
        outcome,
        action: "start_version",
        mode: startVersion.mode,
        worker,
        runFriendlyId,
        createdAfterCutoff: "unknown",
      });

      if (outcome === "version_mismatch" && startVersion.mode === "enforce") {
        throw denied();
      }
    },
  };
}
