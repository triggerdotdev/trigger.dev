import { z } from "zod";
import { prisma } from "~/db.server";
import { fenceUntrusted } from "../gate/fence.server";
import {
  canAccessAlertsIn,
  canUseMonitoringAlerts,
  findMonitoringAlertsProject,
} from "~/services/monitoringAlertsApi.server";
import { createAlertAndSchedule } from "~/v3/services/alerts/alertLifecycle.server";
import type { NewAlertInput } from "~/v3/services/alerts/createAlertFromDraft.server";
import { getAlert, resolveAlert } from "~/v3/services/alerts/storage/alertStore.server";
import { validateAlertNotifiers } from "~/v3/services/alerts/validateAlertNotifiers.server";
import type { McpToolDefinition } from "../registry.server";
import {
  channelError,
  canReadQuery,
  createAlertDraft,
  friendlyChannelIdError,
  draftEffects,
  draftName,
  loadChannels,
  previewWhere,
  QUERY_ACCESS,
  usesCustomQuery,
} from "./alertDrafts.server";
import { resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool, staleApproval } from "./defineWrite.server";
import { nothingChanged, numbered } from "./format/alertPreviews";
import { CreateAlertInput } from "./schemas/alerts";
import { CommonProjectsInput } from "./schemas/common";

import { alertError } from "./format/alerts";

const NOT_ENABLED = "Monitoring alerts are not enabled for this project";

async function createAlertPreview(alert: NewAlertInput, projectId: string) {
  const channels = await loadChannels(projectId, alert.notifiers ?? []);
  return numbered(`Create alert ${draftName(alert)}:`, [
    ...draftEffects(alert, channels),
    "it is scheduled for evaluation now",
  ]);
}

const ResolveAlertInput = CommonProjectsInput.extend({
  alertId: z.string().describe("The id of the alert to resolve. Use list_alerts to find it."),
});

export const alertsWriteTools: McpToolDefinition[] = [
  defineWriteTool({
    name: "create_alert",
    title: "Create Monitoring Alert",
    description:
      "Create a monitoring alert for a project. Use list_alert_capabilities first to find a capabilityKey and understand its condition shape.",
    shape: CreateAlertInput.shape,
    approval: "configurable",
    auth: { action: "write", subject: "alerts" },
    confirm: {
      precheck: (input, ability, subject) =>
        usesCustomQuery([input.capabilityKey]) && !canReadQuery(ability, subject?.environmentType)
          ? QUERY_ACCESS
          : undefined,
      preview: async (input, subject) => {
        const where = previewWhere(subject);
        if (!where) return { refuse: "Not authorized" };
        const alert = createAlertDraft(input, { ...where, createdBy: "" });
        if ("error" in alert) return { refuse: alert.error };
        const invalid = await channelError(alert.notifiers ?? [], where);
        if (invalid) return { refuse: invalid };
        return createAlertPreview(alert, where.projectId);
      },
    },
    run: async (input, ctx) => {
      const project = await findMonitoringAlertsProject(input.projectRef!, ctx.identity.userId);
      if (!project) return alertError("Project not found");
      if (!(await canUseMonitoringAlerts(project, ctx.identity.userId))) {
        return alertError(NOT_ENABLED);
      }

      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return alertError("Not authorized");
      if (usesCustomQuery([input.capabilityKey]) && !canReadQuery(ctx.ability, environment.type)) {
        return alertError("Not authorized");
      }

      const alertInput = createAlertDraft(input, {
        organizationId: project.organizationId,
        projectId: project.id,
        environmentId: environment.id,
        environmentType: environment.type,
        createdBy: ctx.identity.userId,
      });
      if ("error" in alertInput) return alertError(alertInput.error);

      const friendly = friendlyChannelIdError(alertInput.notifiers ?? []);
      if (friendly) return alertError(friendly);
      const notifierError = await validateAlertNotifiers({
        notifiers: alertInput.notifiers ?? [],
        projectId: project.id,
        organizationId: project.organizationId,
        userId: ctx.identity.userId,
        environmentType: environment.type,
      });
      if (notifierError) {
        return alertError(nothingChanged(fenceUntrusted(notifierError.message, "alert-error")));
      }
      const stale = staleApproval(ctx, await createAlertPreview(alertInput, project.id));
      if (stale) return stale;

      const alert = await createAlertAndSchedule(prisma, alertInput);

      return textResult(`Monitoring alert created: ${alert.capabilityKey} (id=${alert.id})`);
    },
  }),
  defineWriteTool({
    name: "resolve_alert",
    title: "Resolve Monitoring Alert",
    description:
      "Resolve a monitoring alert that needs attention, acknowledging it. The alert re-arms after resolving.",
    shape: ResolveAlertInput.shape,
    approval: "configurable",
    auth: { action: "write", subject: "alerts" },
    run: async (input, ctx) => {
      const project = await findMonitoringAlertsProject(input.projectRef!, ctx.identity.userId);
      if (!project) return alertError("Project not found");
      if (!(await canUseMonitoringAlerts(project, ctx.identity.userId))) {
        return alertError(NOT_ENABLED);
      }

      const alert = await getAlert(prisma, { id: input.alertId, projectId: project.id });
      if (!alert) return alertError("Alert not found");

      const { identity } = ctx;
      const { ability } = ctx;
      const outOfScope =
        identity.kind === "uat" &&
        !!identity.environmentId &&
        identity.environmentId !== alert.environmentId;
      if (
        outOfScope ||
        !ability ||
        !(await canAccessAlertsIn(ability, "write", alert.environmentId))
      ) {
        return alertError(fenceUntrusted("Not authorized", "alert-error"));
      }

      const outcome = await resolveAlert(prisma, { id: alert.id, actorId: identity.userId });
      if (!outcome) {
        return alertError(
          nothingChanged(
            "Only an alert that needs attention can be resolved, and this one does not"
          )
        );
      }

      return textResult(`Alert ${outcome.alert.id} resolved.`);
    },
  }),
];
