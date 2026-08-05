/**
 * The context resolution the agent's alert endpoints share: from the turn's environment
 * scope and a chat id to an authorized environment.
 *
 * Same order of authority as the watches route. The environment comes from the token the
 * dashboard minted for the current turn, the chat must be a live chat owned by that user
 * in that environment's org, and the environment is re-authorized through the same path
 * a background check uses. A client-supplied `environmentId` or `projectRef` is only
 * checked against the token's scope, never used in its place, and the chat's stored
 * context is not consulted at all.
 *
 * A separate module so the alert service and the watches service don't import each
 * other.
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
  /** The turn's environment scope, off the user-actor token. The authority here. */
  environmentId: string;
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

  if (params.claimedProjectRef && environment.project.externalRef !== params.claimedProjectRef) {
    return {
      ok: false,
      code: "environment_mismatch",
      error: "That project isn't the one this chat is open in.",
    };
  }

  return { ok: true, environment };
}
