import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { $replica } from "~/db.server";
import { describePendingVersion, type PendingVersionReason } from "./pendingVersionReason";

export type PendingVersionView = PendingVersionReason & {
  /** The engine's cause, e.g. EXTERNAL_DEPLOYMENT_PENDING. */
  statusReason: string | undefined;
  current: { version: string; shortCode: string | undefined } | undefined;
  lockedVersion: string | undefined;
  /** The app deployment a skew-protected run waits for. */
  externalDeploymentId?: string;
};

/** Why a PENDING_VERSION run is parked and which versions matter, for the run panel. */
export async function resolvePendingVersion(run: {
  environmentId: string;
  taskIdentifier: string;
  queueName: string;
  statusReason: string | undefined;
  lockedVersion: string | undefined;
  externalDeploymentId: string | undefined;
}): Promise<PendingVersionView> {
  const environment = await $replica.runtimeEnvironment.findFirst({
    where: { id: run.environmentId },
    select: { type: true },
  });

  let current: PendingVersionView["current"];
  if (environment?.type === "DEVELOPMENT") {
    const worker = await $replica.backgroundWorker.findFirst({
      where: { runtimeEnvironmentId: run.environmentId },
      orderBy: { createdAt: "desc" },
      select: { version: true },
    });
    current = worker ? { version: worker.version, shortCode: undefined } : undefined;
  } else {
    const promotion = await $replica.workerDeploymentPromotion.findFirst({
      where: { environmentId: run.environmentId, label: CURRENT_DEPLOYMENT_LABEL },
      select: { deployment: { select: { version: true, shortCode: true } } },
    });
    current = promotion?.deployment;
  }

  const previous =
    run.statusReason === "TASK_NOT_IN_LATEST"
      ? await $replica.backgroundWorkerTask.findFirst({
          where: { runtimeEnvironmentId: run.environmentId, slug: run.taskIdentifier },
          orderBy: { createdAt: "desc" },
          select: { worker: { select: { version: true } } },
        })
      : null;

  return {
    ...describePendingVersion({
      ...run,
      currentVersion: current?.version,
      previousVersion: previous?.worker.version,
    }),
    statusReason: run.statusReason,
    current,
    lockedVersion: run.lockedVersion,
    externalDeploymentId: run.externalDeploymentId,
  };
}
