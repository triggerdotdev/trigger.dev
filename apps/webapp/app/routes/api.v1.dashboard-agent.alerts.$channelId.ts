import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { resolveAgentAlertContext } from "~/services/dashboardAgentAlertContext.server";
import { unsubscribeChannelFromWatchAlerts } from "~/services/dashboardAgentWatchAlerts.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";

/**
 * `DELETE /api/v1/dashboard-agent/alerts/:channelId` — stop alerting this channel
 * when a watch fires. Same semantics as the email's unsubscribe link.
 *
 * The channel is looked up SCOPED to the chat's project, so a channel id from
 * another project resolves to a 404 rather than being touched.
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

  let body: z.infer<typeof BodySchema>;
  try {
    const parsed = BodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
    }
    body = parsed.data;
  } catch {
    return json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }

  const context = await resolveAgentAlertContext({ userId, ...body });
  if (!context.ok) {
    return json({ error: context.error, code: context.code }, { status: 404 });
  }

  const result = await unsubscribeChannelFromWatchAlerts(parsedParams.data.channelId, {
    projectId: context.environment.project.id,
  });
  if (!result.ok) {
    return json({ error: "Alert not found", code: "not_found" }, { status: 404 });
  }

  return json({ ok: true, disabledChannel: result.disabledChannel });
}
