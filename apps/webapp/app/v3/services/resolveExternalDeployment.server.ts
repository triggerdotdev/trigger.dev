import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import type {
  ExternalDeploymentCache,
  ExternalDeploymentCacheEntry,
} from "~/services/externalDeploymentCache.server";
import { compareDeploymentVersions } from "../utils/deploymentVersions";

const MAX_CANDIDATES = 20;

export type ExternalDeploymentResolution =
  | { outcome: "deployed"; worker: ExternalDeploymentCacheEntry }
  | { outcome: "park" };

export type ResolveExternalDeploymentOptions = {
  prisma: PrismaClientOrTransaction;
  environmentId: string;
  externalDeploymentId: string;
  cache: ExternalDeploymentCache;
};

export async function resolveExternalDeployment({
  prisma,
  environmentId,
  externalDeploymentId,
  cache,
}: ResolveExternalDeploymentOptions): Promise<ExternalDeploymentResolution> {
  const cached = await cache.get(environmentId, externalDeploymentId);

  if (cached?.outcome === "deployed") {
    return { outcome: "deployed", worker: cached.entry };
  }

  if (cached?.outcome === "missing") {
    return { outcome: "park" };
  }

  const worker = await findDeployedWorkerForExternalId({
    prisma,
    environmentId,
    externalDeploymentId,
  });

  if (!worker) {
    await cache.setMissing(environmentId, externalDeploymentId);
    return { outcome: "park" };
  }

  await cache.setIfNewer(environmentId, externalDeploymentId, worker);

  return { outcome: "deployed", worker };
}

type FindDeployedWorkerOptions = {
  prisma: PrismaClientOrTransaction;
  environmentId: string;
  externalDeploymentId: string;
};

async function findDeployedWorkerForExternalId({
  prisma,
  environmentId,
  externalDeploymentId,
}: FindDeployedWorkerOptions): Promise<ExternalDeploymentCacheEntry | undefined> {
  const candidates = await prisma.workerDeployment.findMany({
    where: {
      environmentId,
      externalId: externalDeploymentId,
      status: "DEPLOYED",
    },
    select: {
      version: true,
      worker: {
        select: {
          id: true,
          version: true,
          sdkVersion: true,
          cliVersion: true,
        },
      },
    },
    orderBy: { id: "desc" },
    take: MAX_CANDIDATES,
  });

  let highest: { version: string; worker: ExternalDeploymentCacheEntry } | undefined;

  for (const candidate of candidates) {
    if (!candidate.worker) {
      continue;
    }

    if (highest && compareDeploymentVersions(candidate.version, highest.version) <= 0) {
      continue;
    }

    highest = {
      version: candidate.version,
      worker: {
        workerId: candidate.worker.id,
        version: candidate.worker.version,
        sdkVersion: candidate.worker.sdkVersion ?? "",
        cliVersion: candidate.worker.cliVersion ?? "",
      },
    };
  }

  return highest?.worker;
}
