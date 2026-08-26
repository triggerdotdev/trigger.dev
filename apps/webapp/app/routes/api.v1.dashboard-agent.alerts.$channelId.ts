import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { resolveAgentAlertContext } from "~/services/dashboardAgentAlertContext.server";
import { resolveAgentTokenScope } from "~/services/dashboardAgentTokenScope";
import { unsubscribeChannelFromWatchAlerts } from "~/services/dashboardAgentWatchAlerts.server";
import { logger } from "~/services/logger.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";

/**
 * `DELETE /api/v1/dashboard-agent/alerts/:channelId` — stop alerting this channel
 * when a watch fires. The channel is looked up scoped to the chat's project.
 */

const ParamsSchema = z.object({ channelId: z.string().min(1) });

const BodySchema = z.object({
  chatId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  projectRef: z.string().min(1).optional(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "DELETE") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const authentication = await authenticateUatOrApiRequest(request);
  if (!authentication?.userActor) {
    return json({ error: "Invalid or missing access token" }, { status: 401 });
  }
  if (authentication.userActor.client !== "dashboard-agent") {
    return json({ error: "Not allowed", code: "forbidden_client" }, { status: 403 });
  }
  const userId = authentication.userActor.userId;

  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) return json({ error: "Invalid params" }, { status: 400 });

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }

  const parsedBody = BodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }
  const body = parsedBody.data;

  // The environment this turn may unsubscribe in. There is no trusted fallback.
  const scope = resolveAgentTokenScope(authentication.userActor, {
    environmentId: body.environmentId,
  });
  if (!scope.ok) {
    return json({ error: scope.error, code: scope.code }, { status: 400 });
  }

  try {
    const context = await resolveAgentAlertContext({
      userId,
      environmentId: scope.environmentId,
      organizationId: scope.organizationId,
      chatId: body.chatId,
      claimedEnvironmentId: body.environmentId,
      claimedProjectRef: body.projectRef,
    });
    if (!context.ok) {
      return json(
        { error: context.error, code: context.code },
        { status: context.code === "environment_mismatch" ? 400 : 404 }
      );
    }

    const result = await unsubscribeChannelFromWatchAlerts(parsedParams.data.channelId, {
      projectId: context.environment.project.id,
      // A project is shared by every member, so the caller's own address is part of the scope.
      organizationId: context.environment.organizationId,
      ownerUserId: userId,
    });
    if (!result.ok) {
      if (result.reason === "conflict") {
        return json(
          { error: "That alert was being changed elsewhere. Try again.", code: "conflict" },
          { status: 409 }
        );
      }
      return json({ error: "Alert not found", code: "not_found" }, { status: 404 });
    }

    return json({ ok: true, disabledChannel: result.disabledChannel });
  } catch (error) {
    logger.error("Failed to unsubscribe a channel from dashboard agent watch alerts", {
      error,
      userId,
      environmentId: scope.environmentId,
      channelId: parsedParams.data.channelId,
    });
    throw error;
  }
}
