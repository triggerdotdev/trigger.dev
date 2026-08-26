/**
 * From the turn's environment scope and a chat id to an authorized environment. Same order
 * of authority as the watches route: token environment, chat ownership, re-authorization.
 */

import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  authorizeWatchEnvironmentById,
  resolveChatWatchContext,
} from "~/services/dashboardAgentWatches.server";

export type AgentAlertContextError = "chat_not_found" | "invalid_target" | "environment_mismatch";

export type AgentAlertContext =
  | { ok: true; environment: AuthenticatedEnvironment }
  | { ok: false; code: AgentAlertContextError; error: string };

export async function resolveAgentAlertContext(params: {
  userId: string;
  chatId: string;
  /** The environment this turn resolved to. The authority here. */
  environmentId: string;
  /** Set for an org-wide token: the environment must belong to this org. */
  organizationId?: string;
  /** Optional echoes from the request body. Checked, never trusted. */
  claimedEnvironmentId?: string;
  claimedProjectRef?: string;
}): Promise<AgentAlertContext> {
  if (params.claimedEnvironmentId && params.claimedEnvironmentId !== params.environmentId) {
    return {
      ok: false,
      code: "environment_mismatch",
      error: "That environment isn't the one this chat is open in.",
    };
  }

  const chat = await resolveChatWatchContext({ chatId: params.chatId, userId: params.userId });
  if (!chat) {
    return { ok: false, code: "chat_not_found", error: "Chat not found" };
  }

  const environment = await authorizeWatchEnvironmentById({
    userId: params.userId,
    environmentId: params.environmentId,
  });
  if (!environment || environment.organizationId !== chat.organizationId) {
    return { ok: false, code: "invalid_target", error: "Environment not found" };
  }
  if (params.organizationId && environment.organizationId !== params.organizationId) {
    return { ok: false, code: "invalid_target", error: "Environment not found" };
  }

  if (params.claimedProjectRef && environment.project.externalRef !== params.claimedProjectRef) {
    return {
      ok: false,
      code: "environment_mismatch",
      error: "That project isn't the one this chat is open in.",
    };
  }

  return { ok: true, environment };
}
