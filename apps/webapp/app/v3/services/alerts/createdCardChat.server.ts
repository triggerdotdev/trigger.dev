import { appendChatMessageOnce, chatExists } from "@internal/dashboard-agent-db";
import type { AlertCreatedMessage } from "~/components/alerts/alertCreatedCard";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { logger } from "~/services/logger.server";

type ChatOwner = { chatId: string; userId: string; organizationId: string };

export function ownsChat(owner: ChatOwner) {
  return chatExists(dashboardAgentDb, owner);
}

export async function appendCreatedMessage(
  owner: ChatOwner,
  alertId: string,
  message: AlertCreatedMessage
) {
  try {
    await appendChatMessageOnce(dashboardAgentDb, { ...owner, message });
  } catch (error) {
    logger.error("Failed to append the alert created card", {
      alertId,
      chatId: owner.chatId,
      error,
    });
  }
}
