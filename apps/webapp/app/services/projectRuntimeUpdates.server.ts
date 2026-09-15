import {
  createCache,
  createLRUMemoryStore,
  DefaultStatefulContext,
  Namespace,
} from "@internal/cache";
import { NODE_RUNTIME_UPDATE_MAJOR, nodeMajor } from "@trigger.dev/core/v3";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { RedisCacheStore } from "~/services/unkey/redisCacheStore.server";
import { singleton } from "~/utils/singleton";

const projectRuntimeUpdateCache = singleton("projectRuntimeUpdateCache", () => {
  const context = new DefaultStatefulContext();
  const memory = createLRUMemoryStore(5000, "project-runtime-updates");
  const redis = new RedisCacheStore({
    name: "project-runtime-updates",
    connection: {
      keyPrefix: "tr:cache:project-runtime-updates",
      port: env.CACHE_REDIS_PORT,
      host: env.CACHE_REDIS_HOST,
      username: env.CACHE_REDIS_USERNAME,
      password: env.CACHE_REDIS_PASSWORD,
      tlsDisabled: env.CACHE_REDIS_TLS_DISABLED === "true",
      clusterMode: env.CACHE_REDIS_CLUSTER_MODE_ENABLED === "1",
    },
  });

  return createCache({
    hasUpdate: new Namespace<boolean>(context, {
      stores: [memory, redis],
      fresh: 60_000 * 5,
      stale: 60_000 * 10,
    }),
  });
});

/**
 * The scope is required and exactly one of the two applies: without it the `where` below would
 * collapse to every V3 project on the instance, so a scopeless call must not typecheck.
 */
type Scope =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };

export async function listCurrentProductionProjectRuntimes(scope: Scope) {
  const projects = await prisma.project.findMany({
    where: {
      ...(scope.organizationId !== undefined
        ? { organizationId: scope.organizationId }
        : {
            organization: {
              deletedAt: null,
              members: { some: { userId: scope.userId } },
            },
          }),
      version: "V3",
      deletedAt: null,
    },
    select: {
      name: true,
      slug: true,
      externalRef: true,
      organization: {
        select: {
          title: true,
          slug: true,
        },
      },
      environments: {
        where: { type: "PRODUCTION" },
        select: {
          slug: true,
          workerDeploymentPromotions: {
            where: { label: CURRENT_DEPLOYMENT_LABEL },
            select: {
              deployment: {
                select: {
                  runtime: true,
                  runtimeVersion: true,
                  deployedAt: true,
                  shortCode: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: [{ organization: { title: "asc" } }, { name: "asc" }],
  });

  return projects.flatMap((project) =>
    project.environments.map((environment) => {
      const deployment = environment.workerDeploymentPromotions[0]?.deployment;

      return {
        organization: project.organization,
        project: {
          name: project.name,
          slug: project.slug,
          externalRef: project.externalRef,
        },
        environment: {
          slug: environment.slug,
        },
        deployment: deployment
          ? {
              runtime: deployment.runtime,
              runtimeVersion: deployment.runtimeVersion,
              nodeMajor: nodeMajor(deployment.runtime, deployment.runtimeVersion) ?? null,
              deployedAt: deployment.deployedAt,
              shortCode: deployment.shortCode,
            }
          : null,
      };
    })
  );
}

export async function organizationHasProjectRuntimeUpdate({
  organizationId,
}: {
  organizationId: string;
}): Promise<boolean> {
  const result = await projectRuntimeUpdateCache.hasUpdate.swr(organizationId, async () => {
    const environment = await prisma.runtimeEnvironment.findFirst({
      where: {
        organizationId,
        type: "PRODUCTION",
        project: {
          version: "V3",
          deletedAt: null,
        },
        workerDeploymentPromotions: {
          some: {
            label: CURRENT_DEPLOYMENT_LABEL,
            deployment: {
              OR: [
                {
                  runtimeVersion: { startsWith: `${NODE_RUNTIME_UPDATE_MAJOR}.` },
                  OR: [{ runtime: null }, { runtime: { startsWith: "node" } }],
                },
                {
                  runtimeVersion: null,
                  OR: [
                    { runtime: null },
                    { runtime: "node" },
                    { runtime: `node-${NODE_RUNTIME_UPDATE_MAJOR}` },
                  ],
                },
              ],
            },
          },
        },
      },
      select: { id: true },
    });

    return environment !== null;
  });

  return result.val ?? false;
}

export async function invalidateOrganizationProjectRuntimeUpdateCache(organizationId: string) {
  await projectRuntimeUpdateCache.hasUpdate.remove(organizationId);
}
