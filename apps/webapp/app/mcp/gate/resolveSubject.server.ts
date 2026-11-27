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

const environmentSelect = { id: true, type: true, archivedAt: true } as const;

/** The name as given first, so a listed name like `refs/heads/x` round-trips, then as a git ref. */
export function branchLookupNames(raw: string): string[] {
  const normalized = sanitizeBranchName(raw);
  return normalized && normalized !== raw ? [raw, normalized] : [raw];
}

/** The first non-null lookup, trying the names in order. */
export async function firstBranchMatch<T>(
  names: string[],
  find: (name: string) => Promise<T | null>
): Promise<T | null> {
  for (const name of names) {
    const found = await find(name);
    if (found) return found;
  }
  return null;
}

async function findProject(where: Prisma.ProjectWhereInput) {
  const select = { id: true, organizationId: true } as const;
  return (
    (await $replica.project.findFirst({ where, select })) ??
    (await prisma.project.findFirst({ where, select }))
  );
}

async function findEnvironment(
  where: Prisma.RuntimeEnvironmentWhereInput,
  orderBy?: Prisma.RuntimeEnvironmentOrderByWithRelationInput
) {
  // A lagging replica can still show only an archived predecessor, so archived hits ask the primary.
  const replica = await $replica.runtimeEnvironment.findFirst({
    where,
    orderBy,
    select: environmentSelect,
  });
  return replica && !replica.archivedAt
    ? replica
    : await prisma.runtimeEnvironment.findFirst({ where, orderBy, select: environmentSelect });
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
    if ((slug !== "preview" && slug !== "dev") || typeof branch !== "string" || !branch) {
      return null;
    }
    const parentEnvironmentId = runtimeEnvironment.id;
    // The first name that exists decides, even when archived, so a listed name never falls through.
    const found = await firstBranchMatch(branchLookupNames(branch), (branchName) =>
      findEnvironment(
        { projectId: project.id, parentEnvironmentId, branchName },
        { archivedAt: { sort: "desc", nulls: "first" } }
      )
    );
    runtimeEnvironment = found?.archivedAt ? null : found;
  }
  if (!runtimeEnvironment) return null;

  return {
    ...scope,
    environmentId: runtimeEnvironment.id,
    environmentType: runtimeEnvironment.type,
  };
}
