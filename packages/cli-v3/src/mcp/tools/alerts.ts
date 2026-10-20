import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolsMetadata } from "../config.js";
import {
  CreateAlertInput,
  ListAlertCapabilitiesInput,
  ListAlertsInput,
  ResolveAlertInput,
} from "../schemas.js";
import { respondWithError, toolHandler } from "../utils.js";

function devOnlyError(devOnly: boolean | undefined, environment: string) {
  return devOnly && environment !== "dev"
    ? respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${environment} environment. Remove the --dev-only flag to access other environments.`
      )
    : undefined;
}

type AlertCapabilityParam = {
  key: string;
  label: string;
  unit?: string;
  default: number;
  min?: number;
  max?: number;
};

type AlertCapability = {
  key: string;
  title: string;
  unit?: string;
  area: string;
  allowedKinds: string[];
  allowedScopes: string[];
  params?: AlertCapabilityParam[];
};

/** One `list_alert_capabilities` line. Health capabilities must surface their params
 * (with defaults) so the caller can tune thresholds without a second round trip. */
export function formatCapabilityLine(capability: AlertCapability): string {
  const unit = capability.unit ? ` (${capability.unit})` : "";
  const params = capability.params?.length
    ? ` — params: ${capability.params
        .map((param) => {
          const paramUnit = param.unit ? ` ${param.unit}` : "";
          const range =
            param.min !== undefined || param.max !== undefined
              ? ` [${param.min ?? "-"}, ${param.max ?? "-"}]`
              : "";
          return `${param.key} (${param.label}, default=${param.default}${paramUnit}${range})`;
        })
        .join(", ")}`
    : "";
  return `- ${capability.key}: ${capability.title}${unit} — area=${capability.area}, kinds=${capability.allowedKinds.join(", ")}, scopes=${capability.allowedScopes.join(", ")}${params}`;
}

export const listAlertCapabilitiesTool = {
  name: toolsMetadata.list_alert_capabilities.name,
  title: toolsMetadata.list_alert_capabilities.title,
  description: toolsMetadata.list_alert_capabilities.description,
  inputSchema: ListAlertCapabilitiesInput.shape,
  handler: toolHandler(
    ListAlertCapabilitiesInput.shape,
    async (input, { ctx }): Promise<CallToolResult> => {
      ctx.logger?.log("calling list_alert_capabilities", { input });

      const projectRef = await ctx.getProjectRef({
        projectRef: input.projectRef,
        cwd: input.configPath,
      });

      const cliApiClient = await ctx.getCliApiClient();
      const result = await cliApiClient.listAlertCapabilities(projectRef, input.area);

      if (!result.success) {
        return respondWithError(result.error);
      }

      const contents = result.data.capabilities.map(formatCapabilityLine);

      return {
        content: [
          {
            type: "text",
            text:
              contents.length > 0 ? contents.join("\n") : "No monitoring alert capabilities found.",
          },
        ],
      };
    }
  ),
};

export const listAlertsTool = {
  name: toolsMetadata.list_alerts.name,
  title: toolsMetadata.list_alerts.title,
  description: toolsMetadata.list_alerts.description,
  inputSchema: ListAlertsInput.shape,
  handler: toolHandler(ListAlertsInput.shape, async (input, { ctx }): Promise<CallToolResult> => {
    ctx.logger?.log("calling list_alerts", { input });

    const blocked = devOnlyError(ctx.options.devOnly, input.environment);
    if (blocked) return blocked;

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const cliApiClient = await ctx.getCliApiClient(input.branch);
    const result = await cliApiClient.listAlerts(projectRef, {
      environment: input.environment,
      branch: input.branch,
      lifecycle: input.lifecycle,
      attention: input.attention,
    });

    if (!result.success) {
      return respondWithError(result.error);
    }

    const contents = result.data.alerts.map(
      (alert) =>
        `- ${alert.name ?? "(unnamed)"} (id=${alert.id}) capability=${alert.capabilityKey} lifecycle=${alert.lifecycle} attention=${alert.attention}`
    );

    return {
      content: [
        {
          type: "text",
          text: contents.length > 0 ? contents.join("\n") : "No monitoring alerts found.",
        },
      ],
    };
  }),
};

export const createAlertTool = {
  name: toolsMetadata.create_alert.name,
  title: toolsMetadata.create_alert.title,
  description: toolsMetadata.create_alert.description,
  inputSchema: CreateAlertInput.shape,
  handler: toolHandler(CreateAlertInput.shape, async (input, { ctx }): Promise<CallToolResult> => {
    ctx.logger?.log("calling create_alert", { input });

    const blocked = devOnlyError(ctx.options.devOnly, input.environment);
    if (blocked) return blocked;

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const cliApiClient = await ctx.getCliApiClient(input.branch);
    const result = await cliApiClient.createAlert(projectRef, {
      capabilityKey: input.capabilityKey,
      environment: input.environment,
      branch: input.branch,
      params: input.params,
      condition: input.condition,
      behavior: input.behavior,
      notifiers: input.notifiers,
      name: input.name,
    });

    if (!result.success) {
      return respondWithError(result.error);
    }

    return {
      content: [
        {
          type: "text",
          text: `Monitoring alert created: ${result.data.alert.capabilityKey} (id=${result.data.alert.id})`,
        },
      ],
    };
  }),
};

export const resolveAlertTool = {
  name: toolsMetadata.resolve_alert.name,
  title: toolsMetadata.resolve_alert.title,
  description: toolsMetadata.resolve_alert.description,
  inputSchema: ResolveAlertInput.shape,
  handler: toolHandler(ResolveAlertInput.shape, async (input, { ctx }): Promise<CallToolResult> => {
    ctx.logger?.log("calling resolve_alert", { input });

    const blocked = devOnlyError(ctx.options.devOnly, input.environment);
    if (blocked) return blocked;

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const cliApiClient = await ctx.getCliApiClient(input.branch);

    if (ctx.options.devOnly) {
      const existing = await cliApiClient.getAlert(projectRef, input.alertId);
      if (!existing.success) {
        return respondWithError(existing.error);
      }
      if (existing.data.environmentType !== "DEVELOPMENT") {
        return respondWithError(
          "This MCP server is only available for the dev environment. This alert is not in the dev environment. Remove the --dev-only flag to access other environments."
        );
      }
    }

    const result = await cliApiClient.resolveAlert(projectRef, input.alertId);

    if (!result.success) {
      return respondWithError(result.error);
    }

    return {
      content: [{ type: "text", text: `Alert ${result.data.alert.id} resolved.` }],
    };
  }),
};
