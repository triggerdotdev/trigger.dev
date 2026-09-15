import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { type PrismaClientOrTransaction, type WorkerDeployment } from "@trigger.dev/database";
import { compareDeploymentVersions } from "../../utils/deploymentVersions";
import { FINAL_DEPLOYMENT_STATUSES } from "../failDeployment.server";

const MAX_CANDIDATES = 20;

export type ExternalIdReuseDeployment = Pick<
  WorkerDeployment,
  | "id"
  | "friendlyId"
  | "shortCode"
  | "version"
  | "status"
  | "contentHash"
  | "imageReference"
  | "imagePlatform"
  | "externalId"
>;

type ExternalIdReuseCandidate = ExternalIdReuseDeployment & { promotions: { id: string }[] };

export type ResolveExternalIdReuseResult =
  | { action: "build" }
  | { action: "short-circuit"; deployment: ExternalIdReuseDeployment; isPromoted: boolean }
  | { action: "reject"; deployment: ExternalIdReuseDeployment }
  | {
      action: "cancel-then-build";
      externalId: string;
      deployments: ExternalIdReuseDeployment[];
    };

export type ResolveExternalIdReuseOptions = {
  prisma: PrismaClientOrTransaction;
  environmentId: string;
  externalId?: string;
  force?: boolean;
};

export async function resolveExternalIdReuse({
  prisma,
  environmentId,
  externalId,
  force,
}: ResolveExternalIdReuseOptions): Promise<ResolveExternalIdReuseResult> {
  if (!externalId) {
    return { action: "build" };
  }

  const candidates = await prisma.workerDeployment.findMany({
    where: { environmentId, externalId },
    select: {
      id: true,
      friendlyId: true,
      shortCode: true,
      version: true,
      status: true,
      contentHash: true,
      imageReference: true,
      imagePlatform: true,
      externalId: true,
      promotions: {
        where: { label: CURRENT_DEPLOYMENT_LABEL },
        select: { id: true },
      },
    },
    orderBy: { id: "desc" },
    take: MAX_CANDIDATES,
  });

  const inFlight = byVersionDesc(
    candidates.filter((deployment) => !FINAL_DEPLOYMENT_STATUSES.includes(deployment.status))
  );

  if (force) {
    return inFlight.length
      ? { action: "cancel-then-build", externalId, deployments: inFlight }
      : { action: "build" };
  }

  if (inFlight.length) {
    return { action: "reject", deployment: inFlight[0]! };
  }

  const deployed = byVersionDesc(
    candidates.filter((deployment) => deployment.status === "DEPLOYED")
  );

  if (deployed.length) {
    const deployment = deployed[0]!;
    return { action: "short-circuit", deployment, isPromoted: deployment.promotions.length > 0 };
  }

  return { action: "build" };
}

function byVersionDesc(deployments: ExternalIdReuseCandidate[]): ExternalIdReuseCandidate[] {
  return [...deployments].sort((a, b) => compareDeploymentVersions(b.version, a.version));
}
