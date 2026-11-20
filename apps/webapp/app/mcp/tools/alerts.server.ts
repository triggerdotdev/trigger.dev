import {
  GROUP_CAPABILITY_KEY,
  listCapabilities,
  type NotifierRef,
} from "@internal/alert-contracts";
import { prisma } from "~/db.server";
import { AlertChannelListPresenter } from "~/presenters/v3/AlertChannelListPresenter.server";
import { AlertDetailPresenter, alertDetailName } from "~/presenters/v3/AlertDetailPresenter.server";
import {
  canUseMonitoringAlerts,
  findMonitoringAlertsProject,
} from "~/services/monitoringAlertsApi.server";
import { alertDisplayName } from "~/v3/services/alerts/alertDisplayName";
import { offeredCapabilities } from "~/v3/services/alerts/offeredCapabilities.server";
import {
  getAlert,
  getAlertsByIds,
  listAlertEvents,
  listAlerts,
  listDeliveriesForEvents,
} from "~/v3/services/alerts/storage/alertStore.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, resolveToolEnvironment, textResult } from "./define.server";
import {
  DELIVERY_FETCH_LIMIT,
  MAX_ALERT_CHANNELS,
  MAX_ALERT_EVENTS,
  MAX_ALERT_MEMBERS,
  formatAlertChannelLine,
  formatAlertDetail,
  formatAlertLine,
  formatCapabilityLine,
  formatDeliveries,
} from "./format/alerts";
import {
  GetAlertDetailsInput,
  ListAlertCapabilitiesInput,
  ListAlertChannelsInput,
  ListAlertsInput,
} from "./schemas/alerts";

const NOT_ENABLED = "Monitoring alerts are not enabled for this project";

export const alertsTools: McpToolDefinition[] = [
  defineReadTool({
    name: "list_alert_capabilities",
    title: "List Alert Capabilities",
    description:
      "List what a monitoring alert can watch for a project — queues, runs and health signals. Health capabilities expose tunable params (e.g. thresholds) with defaults, surfaced on each capability. Use this before create_alert to find a valid capabilityKey and its allowed condition shape.",
    shape: ListAlertCapabilitiesInput.shape,
    auth: { action: "read", subject: "alerts" },
    run: async (input, { identity }) => {
      const project = await findMonitoringAlertsProject(input.projectRef!, identity.userId);
      if (!project) return errorResult("Project not found");
      if (!(await canUseMonitoringAlerts(project, identity.userId))) {
        return errorResult(NOT_ENABLED);
      }

      const capabilities = offeredCapabilities(
        listCapabilities({ area: input.area, surface: "mcp" })
      ).map(({ binding, ...capability }) => ({ ...capability, params: binding?.params }));

      return textResult(
        capabilities.length > 0
          ? capabilities.map(formatCapabilityLine).join("\n")
          : "No monitoring alert capabilities found."
      );
    },
  }),
  defineReadTool({
    name: "list_alerts",
    title: "List Monitoring Alerts",
    description:
      "List monitoring alerts for a project and environment, optionally filtered by lifecycle (active/completed/expired/stopped) or attention (clear/needs_attention).",
    shape: ListAlertsInput.shape,
    auth: { action: "read", subject: "alerts" },
    run: async (input, ctx) => {
      const project = await findMonitoringAlertsProject(input.projectRef!, ctx.identity.userId);
      if (!project) return errorResult("Project not found");
      if (!(await canUseMonitoringAlerts(project, ctx.identity.userId))) {
        return errorResult(NOT_ENABLED);
      }

      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Not authorized");

      const alerts = await listAlerts(prisma, {
        environmentId: environment.id,
        projectId: project.id,
        lifecycle: input.lifecycle,
        attention: input.attention,
      });

      return textResult(
        alerts.length > 0
          ? alerts.map((a) => formatAlertLine({ ...a, name: alertDisplayName(a) })).join("\n")
          : "No monitoring alerts found."
      );
    },
  }),
  defineReadTool({
    name: "get_alert_details",
    title: "Get Monitoring Alert Details",
    description:
      "Get one monitoring alert: status, condition, scope, notifiers, expiry, its recent activity with the delivery state of each notification and, for a group alert, its members.",
    shape: GetAlertDetailsInput.shape,
    auth: { action: "read", subject: "alerts" },
    run: async (input, ctx) => {
      const project = await findMonitoringAlertsProject(input.projectRef!, ctx.identity.userId);
      if (!project) return errorResult("Project not found");
      if (!(await canUseMonitoringAlerts(project, ctx.identity.userId))) {
        return errorResult(NOT_ENABLED);
      }

      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Not authorized");

      const where = { id: input.alertId, projectId: project.id, environmentId: environment.id };
      const rawAlert = await getAlert(prisma, where);
      if (!rawAlert) return errorResult("Alert not found");
      const presented = await new AlertDetailPresenter().call({
        ...where,
        skipCurrentReading: true,
      });
      if (!presented) return errorResult("Alert not found");
      const alert = {
        ...presented,
        chatNotifierCount: (rawAlert.notifiers as NotifierRef[]).filter((n) => n.type === "chat")
          .length,
      };

      const events = await listAlertEvents(prisma, rawAlert.id, { limit: MAX_ALERT_EVENTS });
      const rows = await listDeliveriesForEvents(prisma, events, { take: DELIVERY_FETCH_LIMIT });
      const deliveries = formatDeliveries(
        events,
        rows,
        alert.notifiers,
        rows.length === DELIVERY_FETCH_LIMIT
      ).join("\n");

      if (rawAlert.capabilityKey !== GROUP_CAPABILITY_KEY) {
        return textResult(`${formatAlertDetail(alert)}\n${deliveries}`);
      }
      const memberIds = (rawAlert.condition as { memberAlertIds?: string[] }).memberAlertIds ?? [];
      const members = await getAlertsByIds(prisma, {
        ids: memberIds.slice(0, MAX_ALERT_MEMBERS),
        projectId: project.id,
        environmentId: environment.id,
      });
      const detail = formatAlertDetail(alert, {
        total: memberIds.length,
        members: members.map((member) => ({ id: member.id, name: alertDetailName(member) })),
      });
      return textResult(`${detail}\n${deliveries}`);
    },
  }),
  defineReadTool({
    name: "list_alert_channels",
    title: "List Alert Channels",
    description:
      "List the project's alert channels that can deliver for an environment: channelId, friendlyId, name, type, whether it is enabled, the alert and environment types it takes, and its target (email address, Slack channel, or webhook host). Pass the channelId (not the friendlyId) as a channel notifier, e.g. { type: 'channel', channelId }.",
    shape: ListAlertChannelsInput.shape,
    auth: { action: "read", subject: "alerts" },
    run: async (input, ctx) => {
      const project = await findMonitoringAlertsProject(input.projectRef!, ctx.identity.userId);
      if (!project) return errorResult("Project not found");
      if (!(await canUseMonitoringAlerts(project, ctx.identity.userId))) {
        return errorResult(NOT_ENABLED);
      }

      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Not authorized");

      const { alertChannels } = await new AlertChannelListPresenter().call(
        project.id,
        environment.type
      );
      if (alertChannels.length === 0) return textResult("No alert channels found.");

      const lines = alertChannels.slice(0, MAX_ALERT_CHANNELS).map(formatAlertChannelLine);
      if (alertChannels.length > MAX_ALERT_CHANNELS) {
        lines.push(`Showing ${MAX_ALERT_CHANNELS} of ${alertChannels.length} channels.`);
      }
      return textResult(lines.join("\n"));
    },
  }),
];
