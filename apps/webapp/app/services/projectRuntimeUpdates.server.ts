import { NODE_RUNTIME_UPDATE_MAJOR, nodeMajor } from "@trigger.dev/core/v3";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { prisma } from "~/db.server";

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

/**
 * Whether any project in the organization needs a Node.js runtime update in Production.
 *
 * The SQL filter mirrors `needsNodeRuntimeUpdate(runtime, runtimeVersion)`, including legacy
 * deployments with missing runtime metadata. Keep the two in step. Scoped to the caller's
 * membership so the side menu cannot report on an organization the user does not belong to.
 */
export async function organizationHasProjectRuntimeUpdate({
  organizationSlug,
  userId,
}: {
  organizationSlug: string;
  userId: string;
}): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: {
      organization: {
        slug: organizationSlug,
        deletedAt: null,
        members: { some: { userId } },
      },
      version: "V3",
      deletedAt: null,
      environments: {
        some: {
          type: "PRODUCTION",
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
      },
    },
    select: { id: true },
  });

  return project !== null;
}
