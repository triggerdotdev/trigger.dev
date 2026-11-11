import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import type { PrismaClientOrTransaction } from "~/db.server";

const DEFAULT_TEMPLATE_BUILD_ENVIRONMENT_TYPES: RuntimeEnvironmentType[] = [
  "PRODUCTION",
  "STAGING",
  "PREVIEW",
];

export type TemplateBuildSelector = {
  organizationId?: string;
  organizationSlug?: string;
  projectId?: string;
  projectRef?: string;
  environmentTypes?: RuntimeEnvironmentType[];
  /** How many of the newest other DEPLOYED deployments to add per environment. */
  includeRecent?: number;
};

type SelectedDeployment = { deploymentId: string; current: boolean };

export type TemplateBuildSelection =
  | { ok: true; deployments: SelectedDeployment[] }
  | { ok: false; error: "organization_not_found" | "project_not_found" };

/**
 * The deployments a template backfill covers: each matching environment's current deployment,
 * then up to `includeRecent` of its newest other DEPLOYED deployments as rollback targets.
 */
export async function selectTemplateBuildDeployments(
  prisma: PrismaClientOrTransaction,
  selector: TemplateBuildSelector
): Promise<TemplateBuildSelection> {
  const organization = await prisma.organization.findFirst({
    where: {
      ...(selector.organizationId
        ? { id: selector.organizationId }
        : { slug: selector.organizationSlug }),
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!organization) {
    return { ok: false, error: "organization_not_found" };
  }

  let projectId: string | undefined;
  if (selector.projectId || selector.projectRef) {
    const project = await prisma.project.findFirst({
      where: {
        organizationId: organization.id,
        ...(selector.projectId ? { id: selector.projectId } : { externalRef: selector.projectRef }),
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!project) {
      return { ok: false, error: "project_not_found" };
    }
    projectId = project.id;
  }

  const environments = await prisma.runtimeEnvironment.findMany({
    where: {
      organizationId: organization.id,
      ...(projectId ? { projectId } : { project: { deletedAt: null } }),
      // oxlint-disable-next-line trigger-prisma/no-unbounded-list-filter -- At most the four environment types.
      type: { in: selector.environmentTypes ?? DEFAULT_TEMPLATE_BUILD_ENVIRONMENT_TYPES },
      archivedAt: null,
    },
    select: {
      id: true,
      workerDeploymentPromotions: {
        where: { label: CURRENT_DEPLOYMENT_LABEL },
        select: { deploymentId: true },
      },
    },
    orderBy: [{ projectId: "asc" }, { type: "asc" }, { createdAt: "asc" }],
  });

  const includeRecent = selector.includeRecent ?? 0;
  const deployments: SelectedDeployment[] = [];
  for (const environment of environments) {
    const current = environment.workerDeploymentPromotions[0]?.deploymentId;
    if (current) {
      deployments.push({ deploymentId: current, current: true });
    }
    if (includeRecent > 0) {
      const recent = await prisma.workerDeployment.findMany({
        where: {
          environmentId: environment.id,
          status: "DEPLOYED",
          ...(current ? { id: { not: current } } : {}),
        },
        select: { id: true },
        orderBy: { createdAt: "desc" },
        take: includeRecent,
      });
      deployments.push(...recent.map((d) => ({ deploymentId: d.id, current: false })));
    }
  }

  return { ok: true, deployments };
}
