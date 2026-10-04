import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { DASHBOARD_AGENT_FEEDBACK_LIMITS } from "@internal/dashboard-agent-contracts";
import { z } from "zod";
import { resolveAgentAlertContext } from "~/services/dashboardAgentAlertContext.server";
import { logger } from "~/services/logger.server";
import { telemetry } from "~/services/telemetry.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";

/**
 * `POST` records the agent's report of a problem with its own tools or the docs. Only the
 * agent's delegated user-actor token is accepted, and the user, organization, project and
 * environment all come from it and the chat, never from the body.
 */

const FeedbackBodySchema = z.object({
  chatId: z.string().min(1),
  message: z.string().trim().min(1).max(DASHBOARD_AGENT_FEEDBACK_LIMITS.message),
  toolName: z.string().min(1).max(DASHBOARD_AGENT_FEEDBACK_LIMITS.toolName).optional(),
});

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const authentication = await authenticateUatOrApiRequest(request);
  const actor = authentication?.userActor;
  if (!actor || actor.client !== "dashboard-agent") {
    return json({ error: "Invalid or missing access token" }, { status: 401 });
  }
  if (!actor.environmentId) {
    return json(
      { error: "This chat has no environment context.", code: "invalid_target" },
      { status: 400 }
    );
  }

  const body = FeedbackBodySchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) {
    return json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }

  const context = await resolveAgentAlertContext({
    userId: actor.userId,
    environmentId: actor.environmentId,
    chatId: body.data.chatId,
  });
  if (!context.ok) {
    return json({ error: context.error, code: context.code }, { status: 404 });
  }

  const recorded = telemetry.dashboardAgent.feedback({
    userId: actor.userId,
    organizationId: context.environment.organizationId,
    projectId: context.environment.project.id,
    environmentId: context.environment.id,
    chatId: body.data.chatId,
    message: body.data.message,
    toolName: body.data.toolName,
  });
  if (!recorded) {
    return json(
      { error: "Feedback isn't collected on this instance.", code: "feedback_not_configured" },
      { status: 501 }
    );
  }

  logger.info("Dashboard agent feedback submitted", {
    chatId: body.data.chatId,
    toolName: body.data.toolName,
    messageLength: body.data.message.length,
  });
  return json({ recorded: true });
}
