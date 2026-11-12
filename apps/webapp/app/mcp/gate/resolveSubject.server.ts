import type { Prisma } from "@trigger.dev/database";
import { isDefaultDevBranch, sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
import { $replica, prisma } from "~/db.server";
import type { McpIdentity, McpSubject } from "./types";

const ENVIRONMENT_SLUGS: Record<string, string> = {
  dev: "dev",
  staging: "stg",
  prod: "prod",
  preview: "preview",
};

const environmentSelect = { id: true, type: true } as const;

async function findProject(where: Prisma.ProjectWhereInput) {
  const select = { id: true, organizationId: true } as const;
  return (
    (await $replica.project.findFirst({ where, select })) ??
    (await prisma.project.findFirst({ where, select }))
  );
}

async function findEnvironment(where: Prisma.RuntimeEnvironmentWhereInput) {
  return (
    (await $replica.runtimeEnvironment.findFirst({ where, select: environmentSelect })) ??
    (await prisma.runtimeEnvironment.findFirst({ where, select: environmentSelect }))
  );
}

export async function resolveMcpSubject(
  args: unknown,
  identity: McpIdentity
): Promise<McpSubject | null> {
  if (!args || typeof args !== "object") return null;
  const { projectRef, environment, branch } = args as {
    projectRef?: unknown;
    environment?: unknown;
    branch?: unknown;
  };
  if (typeof projectRef !== "string" || projectRef.length === 0) return null;

  const project = await findProject({
    externalRef: projectRef,
    deletedAt: null,
    organization: { deletedAt: null, members: { some: { userId: identity.userId } } },
  });
  if (!project) return null;

  const scope = { organizationId: project.organizationId, projectId: project.id };
  if (environment === undefined && branch === undefined) return scope;

  const slug = typeof environment === "string" ? ENVIRONMENT_SLUGS[environment] : undefined;
  if (!slug) return null;

  let runtimeEnvironment = await findEnvironment({
    projectId: project.id,
    slug,
    ...(slug === "dev" ? { orgMember: { userId: identity.userId } } : {}),
  });

  const branchName = typeof branch === "string" ? sanitizeBranchName(branch) : null;
  const isDefaultBranch = slug === "dev" && !!branchName && isDefaultDevBranch(branchName);
  if (runtimeEnvironment && branch !== undefined && !isDefaultBranch) {
    if ((slug !== "preview" && slug !== "dev") || !branchName) return null;
    runtimeEnvironment = await findEnvironment({
      projectId: project.id,
      parentEnvironmentId: runtimeEnvironment.id,
      branchName,
      archivedAt: null,
    });
  }
  if (!runtimeEnvironment) return null;

  return {
    ...scope,
    environmentId: runtimeEnvironment.id,
    environmentType: runtimeEnvironment.type,
  };
}
