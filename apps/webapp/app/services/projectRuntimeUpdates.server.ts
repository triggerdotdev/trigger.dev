import { NODE_RUNTIME_UPDATE_MAJOR, nodeMajor } from "@trigger.dev/core/v3";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { prisma } from "~/db.server";

type Options = {
  organizationId?: string;
  userId?: string;
};

export async function listCurrentProductionProjectRuntimes({ organizationId, userId }: Options) {
  const projects = await prisma.project.findMany({
    where: {
      ...(organizationId ? { organizationId } : {}),
      ...(userId
        ? {
            organization: {
              deletedAt: null,
              members: { some: { userId } },
            },
          }
        : {}),
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
 * Whether any project in the organization runs the reported Node.js major in Production.
 *
 * The SQL filter mirrors `nodeMajor(runtime, runtimeVersion) === NODE_RUNTIME_UPDATE_MAJOR`, which
 * the page applies in JS: keep the two in step. Scoped to the caller's membership so the side menu
 * cannot report on an organization the user does not belong to.
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
                runtime: { startsWith: "node" },
                runtimeVersion: { startsWith: `${NODE_RUNTIME_UPDATE_MAJOR}.` },
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
