import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { alertActionMessage } from "~/components/alerts/alertActionCard";
import { $replica, prisma } from "~/db.server";
import { hasAccessToEnvironment } from "~/models/runtimeEnvironment.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { canUseAlertsList } from "~/v3/canUseAlertsList.server";
import {
  AlertActionNotAllowedError,
  AlertNotFoundError,
  performAlertAction,
} from "~/v3/services/alerts/alertActions.server";
import { alertDisplayName } from "~/v3/services/alerts/alertDisplayName";
import { appendCreatedMessage, ownsChat } from "~/v3/services/alerts/createdCardChat.server";

const ActionRequestSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  alertId: z.string().min(1),
  intent: z.enum(["resolve", "stop"]),
  toolCallId: z.string().min(1).max(200),
  transcriptChatId: z.string().min(1).optional(),
});

async function bodyScope(_params: unknown, request: Request) {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  const parsed = z
    .object({ organizationId: z.string().optional(), projectId: z.string().optional() })
    .safeParse(body);
  return parsed.success ? parsed.data : {};
}

export const action = dashboardAction(
  { context: bodyScope, authorization: { action: "write", resource: { type: "alerts" } } },
  async ({ request, user, ability }) => {
    const parsed = ActionRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
    }
    const body = parsed.data;

    const access = await hasAccessToEnvironment({
      environmentId: body.environmentId,
      projectId: body.projectId,
      organizationId: body.organizationId,
      userId: user.id,
    });
    if (!access) return json({ error: "No access to this environment" }, { status: 403 });

    const environment = await $replica.runtimeEnvironment.findFirst({
      where: { id: body.environmentId },
      select: {
        type: true,
        project: { select: { organization: { select: { featureFlags: true } } } },
      },
    });
    if (!environment) return json({ error: "No access to this environment" }, { status: 403 });
    const alertsEnabled = await canUseAlertsList({
      orgFeatureFlags:
        (environment.project.organization.featureFlags as Record<string, unknown>) ?? {},
      userId: user.id,
    });
    if (!alertsEnabled) return json({ error: "Alerts not enabled" }, { status: 403 });
    if (!ability.can("write", { type: "alerts", envType: environment.type })) {
      throwPermissionDenied();
    }

    const chat = body.transcriptChatId
      ? { chatId: body.transcriptChatId, userId: user.id, organizationId: body.organizationId }
      : undefined;
    if (chat && !(await ownsChat(chat))) {
      return json({ error: "Invalid chat reference" }, { status: 400 });
    }

    try {
      await performAlertAction(prisma, {
        intent: body.intent,
        alertId: body.alertId,
        projectId: body.projectId,
        environmentId: body.environmentId,
        actorId: user.id,
      });
    } catch (error) {
      if (error instanceof AlertNotFoundError) {
        return json({ error: error.message }, { status: 404 });
      }
      if (error instanceof AlertActionNotAllowedError) {
        return json({ error: error.message }, { status: 409 });
      }
      throw error;
    }

    const alert = await prisma.alert.findFirstOrThrow({
      where: { id: body.alertId },
      select: { name: true, capabilityKey: true, params: true },
    });
    const message = alertActionMessage(body.toolCallId, body.intent, alertDisplayName(alert));
    if (chat) await appendCreatedMessage(chat, body.alertId, message);

    return json({ ok: true, alertId: body.alertId, message });
  }
);
