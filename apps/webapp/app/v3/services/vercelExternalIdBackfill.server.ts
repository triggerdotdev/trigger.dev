import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { normalizeExternalDeploymentId, tryCatch } from "@trigger.dev/core/v3";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import pMap from "p-map";
import { logger } from "~/services/logger.server";

type BackfillEnvironmentResult = {
  /** An environment id, or a project id when `scope` is "project". */
  id: string;
  /** Only set when the failure happened before any environment was resolved. */
  scope?: "project";
  action: "updated" | "would_update" | "skipped_nothing_eligible" | "error";
  eligible?: number;
  written?: number;
  error?: string;
};

export type BackfillResult = {
  projects: number;
  environments: BackfillEnvironmentResult[];
  summary: Record<string, number>;
  deployments: { eligible: number; written: number };
  next?: string;
  done?: boolean;
};

export type BackfillOptions = {
  prisma: PrismaClientOrTransaction;
  replica: PrismaClientOrTransaction;
  cursor?: string;
  limit: number;
  recentPerEnvironment: number;
  parallelism: number;
  dryRun: boolean;
};

type Candidate = { id: string; externalId: string };

/**
 * Copy `commitSHA` into `externalId` for Vercel deployments that predate skew
 * protection, one keyset page of connected projects at a time.
 *
 * Resolution reads (environmentId, externalId, status=DEPLOYED) and a miss parks
 * the run rather than falling back, so a deployment that stores a commit SHA but
 * no external id is unreachable to an app that sends one.
 *
 * `cursor` and `limit` are in OrganizationProjectIntegration ids, so a page is N
 * connected projects and yields however many environments those hold.
 */
export async function backfillVercelExternalIds(options: BackfillOptions): Promise<BackfillResult> {
  const { replica, cursor, limit, parallelism } = options;

  // Paginate over the connected projects rather than over environments. Driving
  // from RuntimeEnvironment means "is this Vercel-connected" sits two joins away
  // from the ordered column, so no index can serve filter and order together and
  // every page has to build the whole matching set and sort it. Here the keyset
  // runs on this table's primary key and the page is bounded by `take`.
  const integrations = await replica.organizationProjectIntegration.findMany({
    where: {
      deletedAt: null,
      organizationIntegration: { service: "VERCEL", deletedAt: null },
      id: cursor ? { gt: cursor } : undefined,
    },
    select: { id: true, projectId: true },
    orderBy: { id: "asc" },
    take: limit,
  });

  if (integrations.length === 0) {
    return {
      projects: 0,
      environments: [],
      summary: {},
      deployments: { eligible: 0, written: 0 },
      done: true,
    };
  }

  const next = integrations[integrations.length - 1]?.id;

  // A project can hold more than one connection row, and reconnecting leaves the
  // old one behind. Deduping keeps a page from walking the same environments twice.
  const projectIds = [...new Set(integrations.map((integration) => integration.projectId))];

  // One equality lookup per project rather than a single `projectId IN (...)`. A
  // wide IN list tips the planner into seq-scanning RuntimeEnvironment, whereas an
  // equality always rides projectId's index. These run concurrently anyway.
  // Nothing in this mapper may throw. `stopOnError: false` does not isolate a
  // rejected mapper: pMap still rejects the whole call with an AggregateError,
  // which would cost the page its results and its `next` cursor.
  const perProject = await pMap(
    projectIds,
    async (projectId): Promise<BackfillEnvironmentResult[]> => {
      const [lookupError, environments] = await tryCatch(
        replica.runtimeEnvironment.findMany({
          where: { projectId, type: { not: "DEVELOPMENT" } },
          select: { id: true },
          orderBy: { id: "asc" },
        })
      );

      if (lookupError) {
        logger.error("Vercel external id backfill could not list environments", {
          projectId,
          error: lookupError,
        });
        return [{ id: projectId, scope: "project", action: "error", error: lookupError.message }];
      }

      const results: BackfillEnvironmentResult[] = [];
      for (const environment of environments) {
        results.push(await backfillEnvironment(environment.id, options));
      }
      return results;
    },
    { concurrency: parallelism, stopOnError: false }
  );

  const results = perProject.flat();

  if (results.length === 0) {
    return {
      projects: projectIds.length,
      environments: [],
      summary: {},
      deployments: { eligible: 0, written: 0 },
      next,
    };
  }

  const summary = results.reduce<Record<string, number>>((acc, result) => {
    acc[result.action] = (acc[result.action] ?? 0) + 1;
    return acc;
  }, {});

  const deployments = results.reduce(
    (acc, result) => ({
      eligible: acc.eligible + (result.eligible ?? 0),
      written: acc.written + (result.written ?? 0),
    }),
    { eligible: 0, written: 0 }
  );

  return {
    projects: projectIds.length,
    environments: results,
    summary,
    deployments,
    next,
  };
}

async function backfillEnvironment(
  environmentId: string,
  options: BackfillOptions
): Promise<BackfillEnvironmentResult> {
  const [readError, candidates] = await tryCatch(findCandidates(environmentId, options));

  if (readError) {
    logger.error("Vercel external id backfill could not read deployments", {
      environmentId,
      error: readError,
    });
    return { id: environmentId, action: "error", error: readError.message };
  }

  if (candidates.length === 0) {
    return { id: environmentId, action: "skipped_nothing_eligible", eligible: 0 };
  }

  if (options.dryRun) {
    return { id: environmentId, action: "would_update", eligible: candidates.length };
  }

  let written = 0;

  for (const candidate of candidates) {
    const [writeError, result] = await tryCatch(
      options.prisma.workerDeployment.updateMany({
        // Re-checking externalId lets a deploy landing mid-backfill keep the id it set.
        where: { id: candidate.id, externalId: null },
        data: { externalId: candidate.externalId },
      })
    );

    if (writeError) {
      logger.error("Vercel external id backfill could not write a deployment", {
        environmentId,
        deploymentId: candidate.id,
        error: writeError,
      });
      return {
        id: environmentId,
        action: "error",
        eligible: candidates.length,
        written,
        error: writeError.message,
      };
    }

    written += result.count;
  }

  return { id: environmentId, action: "updated", eligible: candidates.length, written };
}

/**
 * The deployment holding the `current` promotion, plus the most recent DEPLOYED
 * ones. Only DEPLOYED deployments are ever resolved, and `current` plus a recent
 * window is what can still receive traffic. The window is there for Vercel
 * instant-rollback, where the live app is an older commit than `current`.
 */
async function findCandidates(
  environmentId: string,
  { replica, recentPerEnvironment }: BackfillOptions
): Promise<Candidate[]> {
  const select = {
    id: true,
    externalId: true,
    commitSHA: true,
    workerId: true,
    status: true,
  } as const;

  const [promotion, recent] = await Promise.all([
    replica.workerDeploymentPromotion.findFirst({
      where: { environmentId, label: CURRENT_DEPLOYMENT_LABEL },
      select: { deployment: { select } },
    }),
    recentPerEnvironment > 0
      ? replica.workerDeployment.findMany({
          where: { environmentId, status: "DEPLOYED" },
          select,
          // id DESC, not createdAt: it matches [environmentId, status, id] exactly, so
          // status stays in the index condition and the LIMIT bounds the scan. cuids sort
          // by creation, and resolveExternalDeployment orders its candidates the same way.
          orderBy: { id: "desc" },
          take: recentPerEnvironment,
        })
      : Promise.resolve([]),
  ]);

  const byId = new Map<string, (typeof recent)[number]>();
  for (const deployment of recent) {
    byId.set(deployment.id, deployment);
  }
  if (promotion?.deployment) {
    byId.set(promotion.deployment.id, promotion.deployment);
  }

  const candidates: Candidate[] = [];

  for (const deployment of byId.values()) {
    if (
      deployment.externalId !== null ||
      deployment.workerId === null ||
      deployment.status !== "DEPLOYED"
    ) {
      continue;
    }

    // Reusing the live normalizer keeps a backfilled id byte-identical to what a
    // build would have written.
    const externalId = normalizeExternalDeploymentId(deployment.commitSHA ?? undefined);
    if (!externalId) {
      continue;
    }

    candidates.push({ id: deployment.id, externalId });
  }

  return candidates;
}
