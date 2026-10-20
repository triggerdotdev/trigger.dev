import { useFetcher, useLoaderData } from "@remix-run/react";
import { json, redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { alertTypeTitle } from "~/components/alerts/AlertChannelsBody";
import { hasLegacyAlerts } from "~/components/alerts/hasLegacyAlerts.server";
import { LegacyAlertsSection } from "~/components/alerts/LegacyAlertsSection";
import { useDashboardAgent } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { replacePrefill } from "~/components/dashboard-agent/alert-creation/flow-state";
import {
  replacedMessage,
  toLegacyAlertChannelRows,
  type LegacyAlertChannelRow,
} from "~/components/alerts/legacyAlertChannels";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { AlertChannelListPresenter } from "~/presenters/v3/AlertChannelListPresenter.server";
import { logger } from "~/services/logger.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import {
  EnvironmentParamSchema,
  v3ProjectAlertsPath,
  v3ProjectLegacyAlertsPath,
} from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";
import type { NotifierRef } from "@internal/alert-contracts";
import { chatExists } from "@internal/dashboard-agent-db";
import { boundedIn, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { availableAlertChannelWhere } from "~/v3/services/alerts/validateNotifierChannels.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { DeleteLegacySubscriptionService } from "~/v3/services/alerts/deleteLegacySubscription.server";
import {
  canAcrossEnvironments,
  requireAcrossEnvironments,
} from "~/v3/services/dashboardResourceAccess.server";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import {
  replaceableEnvironments,
  ReplaceLegacySubscriptionService,
  type ReplaceEnvironment,
} from "~/v3/services/alerts/replaceLegacySubscription.server";
import { requireAlertsEnabledOrRedirect } from "~/v3/canUseAlertsList.server";

const DeleteSchema = z.object({
  intent: z.literal("deleteLegacyAlert"),
  channelId: z.string().min(1),
  alertType: z.string().min(1),
});

const ReplaceSchema = z.object({
  intent: z.literal("replace"),
  channelId: z.string().min(1),
  alertType: z.string().min(1),
  environmentIds: z
    .string()
    .min(1)
    .transform((value) => value.split(",").filter(Boolean)),
  value: z.coerce.number().min(0).optional(),
  windowMinutes: z.coerce.number().int().positive().optional(),
  expiresAt: z
    .string()
    .datetime()
    .transform((value) => new Date(value))
    .refine((date) => date.getTime() > Date.now())
    .optional(),
  scopeType: z.enum(["all", "task"]).optional(),
  scopeValue: z.string().min(1).optional(),
  notifierChannelIds: z
    .string()
    .optional()
    .transform((value) => (value ?? "").split(",").filter(Boolean)),
  chatId: z.string().min(1).optional(),
});

const ActionSchema = z.discriminatedUnion("intent", [DeleteSchema, ReplaceSchema]);

export const meta = pageMeta("Legacy alerts");

async function replaceNotifiers(
  project: { id: string; organizationId: string },
  userId: string,
  data: { notifierChannelIds: string[]; chatId?: string }
): Promise<NotifierRef[] | undefined> {
  const ids = [...new Set(data.notifierChannelIds)];
  const channels = ids.length
    ? await prisma.projectAlertChannel.findMany({
        where: {
          id: { in: boundedIn(ids) },
          ...availableAlertChannelWhere({ projectId: project.id }),
        },
        select: { id: true },
      })
    : [];
  if (channels.length !== ids.length) return undefined;
  const notifiers: NotifierRef[] = ids.map((channelId) => ({ type: "channel", channelId }));
  if (data.chatId) {
    const owned = await chatExists(dashboardAgentDb, {
      chatId: data.chatId,
      organizationId: project.organizationId,
      userId,
    });
    if (!owned) return undefined;
    notifiers.push({ type: "chat", chatId: data.chatId, userId });
  }
  return notifiers.length ? notifiers : undefined;
}

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "alerts" } },
  },
  async ({ params, user, ability }) => {
    await requireAlertsEnabledOrRedirect(user.id, params);
    const project = await findProjectWithOrgFlagsBySlug(
      params.organizationSlug,
      params.projectParam,
      user.id
    );
    if (!project) {
      throw new Response(undefined, { status: 404, statusText: "Project not found" });
    }

    if (!(await hasLegacyAlerts(project.id)).hasLegacyAlerts) {
      throw redirect(
        v3ProjectAlertsPath(
          { slug: params.organizationSlug },
          { slug: params.projectParam },
          { slug: params.envParam }
        )
      );
    }

    const environment = await findEnvironmentBySlug(project.id, params.envParam, user.id);
    if (!environment) {
      throw new Response(undefined, { status: 404, statusText: "Environment not found" });
    }
    if (!ability.can("read", { type: "alerts", envType: environment.type })) {
      throwPermissionDenied();
    }
    const canWrite = ability.can("write", { type: "alerts", envType: environment.type });
    const canDelete = ability.can("delete", { type: "alerts", envType: environment.type });
    const { alertChannels } = await new AlertChannelListPresenter().call(
      project.id,
      undefined,
      (channel) => canAcrossEnvironments(ability, "write", "alerts", channel.environmentTypes)
    );
    const legacyChannels = toLegacyAlertChannelRows(alertChannels, alertTypeTitle).map((row) => {
      const environmentTypes =
        alertChannels.find((channel) => channel.id === row.id)?.environmentTypes ?? [];
      return {
        ...row,
        canWrite: canAcrossEnvironments(ability, "write", "alerts", environmentTypes),
        canDelete: canAcrossEnvironments(ability, "delete", "alerts", environmentTypes),
      };
    });
    const environments = await replaceableEnvironments(
      prisma,
      project.id,
      ["PRODUCTION", "STAGING", "DEVELOPMENT", "PREVIEW"],
      user.id
    );
    const replaceEnvironments = Object.fromEntries(
      alertChannels.map((channel) => [
        channel.id,
        environments.filter((environment) => channel.environmentTypes.includes(environment.type)),
      ])
    );
    return json({ legacyChannels, canWrite, canDelete, replaceEnvironments });
  }
);

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "write", resource: { type: "alerts" } },
  },
  async ({ params, user, request, ability }) => {
    await requireAlertsEnabledOrRedirect(user.id, params);
    const redirectTo = v3ProjectLegacyAlertsPath(
      { slug: params.organizationSlug },
      { slug: params.projectParam },
      { slug: params.envParam }
    );
    const alertsPath = v3ProjectAlertsPath(
      { slug: params.organizationSlug },
      { slug: params.projectParam },
      { slug: params.envParam }
    );
    const form = Object.fromEntries(await request.formData());
    const parsed = ActionSchema.safeParse(form);
    if (!parsed.success) {
      return form.intent === "replace"
        ? json({ error: "Invalid request" }, { status: 400 })
        : redirectWithErrorMessage(redirectTo, request, "Invalid request");
    }
    const data = parsed.data;
    if (data.intent === "replace" && data.scopeType === "task" && !data.scopeValue) {
      return json({ error: "Pick a task" }, { status: 400 });
    }

    const project = await findProjectWithOrgFlagsBySlug(
      params.organizationSlug,
      params.projectParam,
      user.id
    );
    if (!project) {
      throw new Response(undefined, { status: 404, statusText: "Project not found" });
    }

    if (data.intent === "deleteLegacyAlert") {
      const environment = await findEnvironmentBySlug(project.id, params.envParam, user.id);
      if (!environment) {
        throw new Response(undefined, { status: 404, statusText: "Environment not found" });
      }
      if (!ability.can("delete", { type: "alerts", envType: environment.type })) {
        throwPermissionDenied();
      }
    } else {
      const environments = await prisma.runtimeEnvironment.findMany({
        where: { id: { in: boundedIn(data.environmentIds) }, projectId: project.id },
        select: { type: true },
      });
      if (environments.some((e) => !ability.can("write", { type: "alerts", envType: e.type }))) {
        throwPermissionDenied();
      }
    }
    const authorize = (environmentTypes: RuntimeEnvironmentType[]) =>
      requireAcrossEnvironments(
        ability,
        data.intent === "deleteLegacyAlert" ? "delete" : "write",
        "alerts",
        environmentTypes
      );
    if (data.intent === "replace") {
      const channel = await prisma.projectAlertChannel.findFirst({
        where: { id: data.channelId, projectId: project.id },
        select: { environmentTypes: true },
      });
      if (channel) {
        authorize(channel.environmentTypes);
      }
    }

    try {
      if (data.intent === "deleteLegacyAlert") {
        await new DeleteLegacySubscriptionService().call({
          projectId: project.id,
          channelId: data.channelId,
          alertType: data.alertType,
          authorize,
        });
        const remaining = await hasLegacyAlerts(project.id);
        return redirectWithSuccessMessage(
          remaining.hasLegacyAlerts ? redirectTo : alertsPath,
          request,
          "Legacy alert deleted"
        );
      }
      const notifiers = await replaceNotifiers(project, user.id, data);
      if (!notifiers) {
        return json({ error: "One or more selected notifiers were not found" }, { status: 400 });
      }
      const result = await new ReplaceLegacySubscriptionService().call({
        projectId: project.id,
        channelId: data.channelId,
        alertType: data.alertType,
        userId: user.id,
        environmentIds: data.environmentIds,
        value: data.value,
        windowSec: data.windowMinutes ? data.windowMinutes * 60 : undefined,
        expiresAt: data.expiresAt,
        scope:
          data.scopeType === "task" && data.scopeValue
            ? { type: "task", taskIdentifier: data.scopeValue }
            : undefined,
        notifiers,
        authorize,
      });
      if (!result.replaced) {
        return json({ error: "Already replaced" }, { status: 409 });
      }
      return json({
        count: result.alertIds.length,
        message: replacedMessage(result.alertIds.length, result.skipped),
        legacyRemaining: (await hasLegacyAlerts(project.id)).hasLegacyAlerts,
      });
    } catch (error) {
      if (error instanceof Response) throw error;
      if (error instanceof ServiceValidationError) {
        return data.intent === "replace"
          ? json({ error: error.message }, { status: 400 })
          : redirectWithErrorMessage(redirectTo, request, error.message);
      }
      logger.error("Failed to replace legacy alert subscription", {
        organizationId: project.organizationId,
        projectId: project.id,
        userId: user.id,
        error,
      });
      throw error;
    }
  }
);

export default function Page() {
  const { legacyChannels, canWrite, canDelete, replaceEnvironments } =
    useLoaderData() as unknown as {
      legacyChannels: LegacyAlertChannelRow[];
      canWrite: boolean;
      canDelete: boolean;
      replaceEnvironments: Record<string, ReplaceEnvironment[]>;
    };
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useFetcher();
  const agent = useDashboardAgent();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title="Legacy alerts"
          backButton={{
            to: v3ProjectAlertsPath(organization, project, environment),
            text: "Alerts",
          }}
        />
      </NavBar>
      <PageBody scrollable={legacyChannels.length > 0}>
        <LegacyAlertsSection
          channels={legacyChannels}
          canWrite={canWrite}
          canDelete={canDelete}
          replacing={!agent || fetcher.state !== "idle"}
          onDelete={(row) =>
            fetcher.submit(
              { intent: "deleteLegacyAlert", channelId: row.channelId, alertType: row.alertType },
              { method: "post" }
            )
          }
          onReplace={(row) =>
            agent?.openCreateAlert(replacePrefill(row, replaceEnvironments[row.channelId] ?? []))
          }
        />
      </PageBody>
    </PageContainer>
  );
}
