import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { resolveAgentAlertContext } from "~/services/dashboardAgentAlertContext.server";
import { unsubscribeChannelFromWatchAlerts } from "~/services/dashboardAgentWatchAlerts.server";
import { logger } from "~/services/logger.server";
import { rbac } from "~/services/rbac.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";
import { canAcrossEnvironments } from "~/v3/services/dashboardResourceAccess.server";

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
  // The turn's environment scope is the authority for the chat's project below.
  const environmentId = authentication.userActor.environmentId;
  if (!environmentId) {
    return json(
      { error: "This chat has no environment context.", code: "invalid_target" },
      { status: 400 }
    );
  }

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

  try {
    const context = await resolveAgentAlertContext({
      userId,
      environmentId,
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

    const access = await rbac.authenticateUserActor(request, {
      organizationId: context.environment.organizationId,
      projectId: context.environment.project.id,
    });
    if (!access.ok) {
      return json({ error: access.error }, { status: access.status });
    }

    const result = await unsubscribeChannelFromWatchAlerts(parsedParams.data.channelId, {
      projectId: context.environment.project.id,
      // A project is shared by every member, so the caller's own address is part of the scope.
      organizationId: context.environment.organizationId,
      ownerUserId: userId,
      authorize: (environmentTypes) =>
        canAcrossEnvironments(access.ability, "write", "alerts", environmentTypes),
    });
    if (!result.ok) {
      if (result.reason === "forbidden") {
        return json({ error: "You don't have permission to manage alerts" }, { status: 403 });
      }
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
      environmentId,
      channelId: parsedParams.data.channelId,
    });
    throw error;
  }
}
