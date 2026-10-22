import { chatExists } from "@internal/dashboard-agent-db";
import type { NotifierRef } from "@internal/alert-contracts";
import { boundedIn, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { availableAlertChannelWhere } from "./validateNotifierChannels.server";

export interface NotifierOwnershipError {
  reason: "channel" | "chat";
  message: string;
}

/**
 * Every notifier a caller names has to already belong to them: a channel to
 * this project, a chat to this org and this acting user. Callers map the
 * returned `reason` to their own HTTP status.
 */
export async function validateAlertNotifiers(params: {
  notifiers: NotifierRef[];
  projectId: string;
  organizationId: string;
  userId: string;
  environmentType: RuntimeEnvironmentType;
}): Promise<NotifierOwnershipError | null> {
  const channelIds = params.notifiers
    .filter(
      (notifier): notifier is Extract<NotifierRef, { type: "channel" }> =>
        notifier.type === "channel"
    )
    .map((notifier) => notifier.channelId);

  if (channelIds.length > 0) {
    const channels = await $replica.projectAlertChannel.findMany({
      where: {
        id: { in: boundedIn(channelIds) },
        ...availableAlertChannelWhere({
          projectId: params.projectId,
          environmentType: params.environmentType,
        }),
      },
      select: { id: true },
    });
    const foundIds = new Set(channels.map((c) => c.id));
    const missing = channelIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return {
        reason: "channel",
        message: `notifier channel(s) not found on this project: ${missing.join(", ")}`,
      };
    }
  }

  const chatIds = params.notifiers
    .filter(
      (notifier): notifier is Extract<NotifierRef, { type: "chat" }> => notifier.type === "chat"
    )
    .map((notifier) => notifier.chatId)
    .filter((chatId): chatId is string => Boolean(chatId));

  for (const chatId of chatIds) {
    const exists = await chatExists(dashboardAgentDb, {
      chatId,
      userId: params.userId,
      organizationId: params.organizationId,
    });
    if (!exists) {
      return { reason: "chat", message: `notifier chat not found: ${chatId}` };
    }
  }

  return null;
}
