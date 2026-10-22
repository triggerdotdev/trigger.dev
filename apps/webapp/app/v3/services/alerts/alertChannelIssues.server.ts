import type { NotifierRef } from "@internal/alert-contracts";
import {
  boundedIn,
  type PrismaClientOrTransaction,
  type ProjectAlertChannelType,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";

export type NotifierChannel = {
  id: string;
  name: string;
  enabled: boolean;
  type: ProjectAlertChannelType;
  integrationId: string | null;
  environmentTypes: RuntimeEnvironmentType[];
};

export type AlertChannelIssue = {
  channelId: string;
  name: string | null;
  reason: "disabled" | "environment" | "integration" | "deleted";
};

function issueReason(
  channel: NotifierChannel | undefined,
  environmentType: RuntimeEnvironmentType | null
): AlertChannelIssue["reason"] | null {
  if (!channel) return "deleted";
  if (!channel.enabled) return "disabled";
  if (environmentType && !channel.environmentTypes.includes(environmentType)) {
    return "environment";
  }
  if (channel.type === "SLACK" && !channel.integrationId) return "integration";
  return null;
}

export function alertChannelIssues(
  notifiers: NotifierRef[],
  channels: Map<string, NotifierChannel>,
  environmentType: RuntimeEnvironmentType | null
): AlertChannelIssue[] {
  const issues: AlertChannelIssue[] = [];
  const seen = new Set<string>();
  for (const notifier of notifiers) {
    if (notifier.type !== "channel" || seen.has(notifier.channelId)) continue;
    seen.add(notifier.channelId);
    const channel = channels.get(notifier.channelId);
    const reason = issueReason(channel, environmentType);
    if (reason) issues.push({ channelId: notifier.channelId, name: channel?.name ?? null, reason });
  }
  return issues;
}

export function notifierChannelIds(notifiers: NotifierRef[]): string[] {
  return [...new Set(notifiers.flatMap((n) => (n.type === "channel" ? [n.channelId] : [])))];
}

export async function loadNotifierChannels(
  prisma: PrismaClientOrTransaction,
  {
    projectId,
    environmentId,
    channelIds,
  }: { projectId: string; environmentId: string; channelIds: string[] }
): Promise<{
  environmentType: RuntimeEnvironmentType | null;
  channels: Map<string, NotifierChannel>;
}> {
  if (channelIds.length === 0) return { environmentType: null, channels: new Map() };
  const [environment, rows] = await Promise.all([
    prisma.runtimeEnvironment.findFirst({
      where: { id: environmentId, projectId },
      select: { type: true },
    }),
    prisma.projectAlertChannel.findMany({
      where: { id: { in: boundedIn(channelIds) }, projectId },
      select: {
        id: true,
        name: true,
        enabled: true,
        type: true,
        integrationId: true,
        properties: true,
        environmentTypes: true,
      },
    }),
  ]);
  return {
    environmentType: environment?.type ?? null,
    channels: new Map(
      rows.map(({ properties, ...row }) => {
        const legacyIntegrationId = (properties as { integrationId?: unknown } | null)
          ?.integrationId;
        return [
          row.id,
          {
            ...row,
            integrationId:
              row.integrationId ??
              (typeof legacyIntegrationId === "string" && legacyIntegrationId
                ? legacyIntegrationId
                : null),
          },
        ];
      })
    ),
  };
}
