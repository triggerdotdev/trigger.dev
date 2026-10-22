import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { boundedIn } from "@trigger.dev/database";
import type { NotifierRef } from "@internal/alert-contracts";
import { appendChatMessageOnce, chatExists } from "@internal/dashboard-agent-db";
import {
  alertCreatedMessage,
  answersFromCreateRequest,
  createdCardFields,
  type AlertCreatedMessage,
} from "~/components/alerts/alertCreatedCard";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { $replica, prisma } from "~/db.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { hasAccessToEnvironment } from "~/models/runtimeEnvironment.server";
import {
  createAlertFromDraft,
  UnknownCapabilityError,
  IncompatibleAlertKindError,
  AbsenceWindowTooShortError,
  InvalidConditionParamsError,
  InvalidScopeForCapabilityError,
  NoNotifiersError,
  IncompleteChatNotifierError,
  InvalidNotifierError,
} from "~/v3/services/alerts/createAlertFromDraft.server";
import {
  buildCondition,
  buildScope,
  ChatRequestSchema as RequestSchema,
} from "~/v3/services/alerts/alertDraft";
import type { AlertDraftScope } from "~/v3/services/alerts/alertDraft";
import { findValidNotifierChannelIds } from "~/v3/services/alerts/validateNotifierChannels.server";
import { canUseAlertsList } from "~/v3/canUseAlertsList.server";
import { logger } from "~/services/logger.server";
import { throwPermissionDenied } from "~/utils/permissionDenied";

const DOMAIN_ERRORS = [
  UnknownCapabilityError,
  IncompatibleAlertKindError,
  AbsenceWindowTooShortError,
  InvalidConditionParamsError,
  InvalidScopeForCapabilityError,
  NoNotifiersError,
  IncompleteChatNotifierError,
  InvalidNotifierError,
];

const ScopeSchema = z.object({
  organizationId: z.string().optional(),
  projectId: z.string().optional(),
});

async function bodyScope(_params: unknown, request: Request) {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  const parsed = ScopeSchema.safeParse(body);
  return parsed.success ? parsed.data : {};
}

export const action = dashboardAction(
  { context: bodyScope, authorization: { action: "write", resource: { type: "alerts" } } },
  async ({ request, user, ability }) => {
    const userId = user.id;
    const raw = await request.json();
    const parsed = RequestSchema.safeParse(raw);
    if (!parsed.success) {
      return json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
    }
    const body = parsed.data;

    const access = await hasAccessToEnvironment({
      environmentId: body.environmentId,
      projectId: body.projectId,
      organizationId: body.organizationId,
      userId,
    });
    if (!access) {
      return json({ error: "No access to this environment" }, { status: 403 });
    }

    const org = await $replica.organization.findFirst({
      where: { id: body.organizationId, members: { some: { userId } } },
      select: { featureFlags: true },
    });
    const alertsEnabled = await canUseAlertsList({
      orgFeatureFlags: (org?.featureFlags as Record<string, unknown>) ?? {},
      userId,
    });
    if (!alertsEnabled) {
      return json({ error: "Alerts not enabled" }, { status: 403 });
    }

    const environment = await $replica.runtimeEnvironment.findFirst({
      where: { id: body.environmentId },
      select: { type: true, branchName: true },
    });
    if (!environment) {
      return json({ error: "No access to this environment" }, { status: 403 });
    }
    if (!ability.can("write", { type: "alerts", envType: environment.type })) {
      throwPermissionDenied();
    }

    const validChannelIds = await findValidNotifierChannelIds(
      $replica,
      body.projectId,
      body.form.notifierChannelIds,
      environment.type
    );
    if (validChannelIds.length !== body.form.notifierChannelIds.length) {
      return json({ error: "One or more selected notifiers were not found" }, { status: 400 });
    }

    if (body.transcriptChatId) {
      const owned = await chatExists(dashboardAgentDb, {
        chatId: body.transcriptChatId,
        organizationId: body.organizationId,
        userId,
      });
      if (!owned) {
        return json({ error: "Invalid chat reference" }, { status: 400 });
      }
    }

    const notifiers: NotifierRef[] = validChannelIds.map((channelId): NotifierRef => ({
      type: "channel",
      channelId,
    }));

    if (body.chatNotifier === "on") {
      if (body.chatId) {
        const owned = await chatExists(dashboardAgentDb, {
          chatId: body.chatId,
          organizationId: body.organizationId,
          userId,
        });
        if (!owned) {
          return json({ error: "Invalid chat reference" }, { status: 400 });
        }
      }
      notifiers.push({ type: "chat", chatId: body.chatId, userId });
    }

    try {
      const alert = await createAlertFromDraft(prisma, {
        organizationId: body.organizationId,
        projectId: body.projectId,
        environmentId: body.environmentId,
        name: body.name,
        capabilityKey: body.form.capabilityKey,
        scope: buildScope(body.form) as AlertDraftScope,
        condition: buildCondition(body.form),
        expiresAt: body.form.expiresAt ? new Date(body.form.expiresAt) : undefined,
        notifiers,
        createdBy: userId,
      });

      const message = await appendCreatedCard({
        alertId: alert.id,
        alertName: alert.name,
        body,
        userId,
        validChannelIds,
        environmentTitle: environmentFullTitle(environment),
      });

      return json({ ok: true, alertId: alert.id, alertName: alert.name, message });
    } catch (error) {
      if (DOMAIN_ERRORS.some((cls) => error instanceof cls)) {
        return json({ error: (error as Error).message }, { status: 400 });
      }
      logger.error("Failed to create alert from chat", {
        organizationId: body.organizationId,
        projectId: body.projectId,
        environmentId: body.environmentId,
        userId,
        error,
      });
      return json({ error: "Internal error" }, { status: 500 });
    }
  }
);

async function appendCreatedCard({
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
  body: z.infer<typeof RequestSchema>;
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
    const fields = createdCardFields(
      answersFromCreateRequest(body),
      channels,
      alertName ?? undefined,
      envTitle
    );
    message = fields ? alertCreatedMessage(alertId, fields) : undefined;
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
