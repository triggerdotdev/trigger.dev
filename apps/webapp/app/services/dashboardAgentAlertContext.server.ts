/**
 * The context resolution the agent's alert endpoints share: from a chat id to an
 * authorized environment.
 *
 * Identical order of authority to `api.v1.dashboard-agent.watches.ts` — the token
 * names a user, the chat must be a live chat owned by that user, and the
 * environment (from the caller or the chat's stored context) is re-authorized
 * through the same path a background check uses. Nothing here trusts an id.
 *
 * Separate module rather than a helper on `dashboardAgentWatchAlerts.server.ts` so
 * the alert service and the watches service don't import each other.
 */

import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  authorizeWatchEnvironmentById,
  resolveChatWatchContext,
} from "~/services/dashboardAgentWatches.server";

export type AgentAlertContextError = "chat_not_found" | "invalid_target";

export type AgentAlertContext =
  | { ok: true; environment: AuthenticatedEnvironment }
  | { ok: false; code: AgentAlertContextError; error: string };

export async function resolveAgentAlertContext(params: {
  userId: string;
  chatId: string;
  environmentId?: string;
  projectRef?: string;
}): Promise<AgentAlertContext> {
  const chat = await resolveChatWatchContext({ chatId: params.chatId, userId: params.userId });
  if (!chat) {
    return { ok: false, code: "chat_not_found", error: "Chat not found" };
  }

  const environmentId = params.environmentId ?? chat.environmentId;
  if (!environmentId) {
    return {
      ok: false,
      code: "invalid_target",
      error: "This chat has no environment context.",
    };
  }

  const environment = await authorizeWatchEnvironmentById({
    userId: params.userId,
    environmentId,
  });
  if (!environment || environment.organizationId !== chat.organizationId) {
    return { ok: false, code: "invalid_target", error: "Environment not found" };
  }

  const projectRef = params.projectRef ?? chat.projectRef;
  if (projectRef && environment.project.externalRef !== projectRef) {
    return { ok: false, code: "invalid_target", error: "Environment not found" };
  }

  return { ok: true, environment };
}
