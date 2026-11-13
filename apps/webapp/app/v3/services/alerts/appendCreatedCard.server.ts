import { boundedIn } from "@trigger.dev/database";
import { appendChatMessageOnce } from "@internal/dashboard-agent-db";
import type { z } from "zod";
import {
  alertCreatedMessage,
  requestCardFields,
  type AlertCreatedMessage,
} from "~/components/alerts/alertCreatedCard";
import { $replica } from "~/db.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { logger } from "~/services/logger.server";
import type { ChatRequestSchema } from "~/v3/services/alerts/alertDraft";

export async function appendCreatedCard({
  alertId,
  alertName,
  body,
  userId,
  validChannelIds,
  environmentTitle: envTitle,
}: {
  environmentTitle: string;
  alertId: string;
  alertName: string | null;
  body: z.infer<typeof ChatRequestSchema>;
  userId: string;
  validChannelIds: string[];
}) {
  let message: AlertCreatedMessage | undefined;
  try {
    const channels = validChannelIds.length
      ? await $replica.projectAlertChannel.findMany({
          where: { id: { in: boundedIn(validChannelIds) }, projectId: body.projectId },
          select: { id: true, name: true, type: true },
        })
      : [];
    const fields = requestCardFields(body, channels, alertName ?? undefined, envTitle);
    message = fields ? alertCreatedMessage(alertId, fields, body.planItemKey) : undefined;
    if (message && body.transcriptChatId) {
      await appendChatMessageOnce(dashboardAgentDb, {
        chatId: body.transcriptChatId,
        userId,
        organizationId: body.organizationId,
        message,
      });
    }
  } catch (error) {
    logger.error("Failed to append the alert created card", {
      alertId,
      chatId: body.transcriptChatId,
      error,
    });
  }
  return message;
}
