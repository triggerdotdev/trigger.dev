import {
  boundedIn,
  Prisma,
  type PrismaReplicaClient,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";

export function availableAlertChannelWhere({
  projectId,
  environmentType,
}: {
  projectId: string;
  environmentType?: RuntimeEnvironmentType;
}): Prisma.ProjectAlertChannelWhereInput {
  return {
    projectId,
    enabled: true,
    ...(environmentType ? { environmentTypes: { has: environmentType } } : {}),
    OR: [
      { type: { not: "SLACK" } },
      { integrationId: { not: null } },
      {
        AND: [
          { properties: { path: ["integrationId"], not: Prisma.JsonNull } },
          { properties: { path: ["integrationId"], not: "" } },
        ],
      },
    ],
  };
}

/**
 * Returns only the given channel ids that can deliver for `projectId` in `environmentType`.
 * Used to reject a foreign/disabled/undeliverable channel id in a notifier selection
 * instead of trusting form input.
 */
export async function findValidNotifierChannelIds(
  prisma: PrismaReplicaClient,
  projectId: string,
  channelIds: string[],
  environmentType: RuntimeEnvironmentType
): Promise<string[]> {
  if (channelIds.length === 0) return [];

  const rows = await prisma.projectAlertChannel.findMany({
    where: {
      id: { in: boundedIn(channelIds) },
      ...availableAlertChannelWhere({ projectId, environmentType }),
    },
    select: { id: true },
  });

  return rows.map((row) => row.id);
}
