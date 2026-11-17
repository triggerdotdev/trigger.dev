import { listCapabilities } from "@internal/alert-contracts";
import { prisma } from "~/db.server";
import {
  canUseMonitoringAlerts,
  findMonitoringAlertsProject,
} from "~/services/monitoringAlertsApi.server";
import { alertDisplayName } from "~/v3/services/alerts/alertDisplayName";
import { offeredCapabilities } from "~/v3/services/alerts/offeredCapabilities.server";
import { listAlerts } from "~/v3/services/alerts/storage/alertStore.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { formatAlertLine, formatCapabilityLine } from "./format/alerts";
import { ListAlertCapabilitiesInput, ListAlertsInput } from "./schemas/alerts";

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
];
