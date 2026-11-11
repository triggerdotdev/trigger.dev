import type { NotifierRef } from "@internal/alert-contracts";
import { boundedIn, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { availableAlertChannelWhere } from "./validateNotifierChannels.server";

export interface NotifierOwnershipError {
  reason: "channel" | "chat" | "none";
  message: string;
}

/**
 * Every notifier a caller names must be a channel already on this project.
 * Callers map the returned `reason` to their own HTTP status.
 */
export async function validateAlertNotifiers(params: {
  notifiers: NotifierRef[];
  projectId: string;
  organizationId: string;
  userId: string;
  environmentType: RuntimeEnvironmentType;
}): Promise<NotifierOwnershipError | null> {
  if (params.notifiers.length === 0) {
    return { reason: "none", message: "At least one channel is required" };
  }
  if (params.notifiers.some((notifier) => notifier.type === "chat")) {
    return { reason: "chat", message: "Chat notifiers are not supported" };
  }

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

  return null;
}
