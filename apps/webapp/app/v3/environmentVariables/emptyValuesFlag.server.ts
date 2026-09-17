import { prisma, type PrismaClient } from "~/db.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

export const EMPTY_ENV_VALUES_DISABLED =
  "Empty environment variable values are not enabled for this organization.";

export async function emptyEnvironmentVariableValuesEnabled(
  organizationFeatureFlags: unknown,
  client: PrismaClient = prisma
): Promise<boolean> {
  const enabled = await makeFlag(client)({
    key: FEATURE_FLAG.allowEmptyEnvironmentVariableValues,
    defaultValue: false,
    overrides:
      organizationFeatureFlags && typeof organizationFeatureFlags === "object"
        ? (organizationFeatureFlags as Record<string, unknown>)
        : undefined,
  });
  return enabled;
}

export async function emptyEnvironmentVariableValuesEnabledForProject(
  projectId: string,
  client: PrismaClient = prisma
): Promise<boolean> {
  const project = await client.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { organization: { select: { featureFlags: true } } },
  });
  return project
    ? emptyEnvironmentVariableValuesEnabled(project.organization.featureFlags, client)
    : false;
}
