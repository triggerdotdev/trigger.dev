import { GROUP_CAPABILITY_KEY, validateConditionParams } from "@internal/alert-contracts";
import { z } from "zod";
import { prisma } from "~/db.server";
import {
  canAccessAlertsIn,
  canUseMonitoringAlerts,
  defaultCapabilityLookup,
  findMonitoringAlertsProject,
} from "~/services/monitoringAlertsApi.server";
import { createAlertAndSchedule } from "~/v3/services/alerts/alertLifecycle.server";
import { MonitoringAlertsCreateBodySchema } from "~/v3/services/alerts/monitoringAlertsSchemas";
import { getAlert, resolveAlert } from "~/v3/services/alerts/storage/alertStore.server";
import { stateFields, validateAlertDraft } from "~/v3/services/alerts/validateAlertDraft.server";
import { validateAlertNotifiers } from "~/v3/services/alerts/validateAlertNotifiers.server";
import type { McpToolDefinition } from "../registry.server";
import { errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool, fencedError } from "./defineWrite.server";
import { CommonProjectsInput } from "./schemas/common";

const NOT_ENABLED = "Monitoring alerts are not enabled for this project";

const AlertScope = z.object({
  type: z.enum(["queue", "queuePattern", "task", "all", "errorGroup"]),
  queue: z.string().optional(),
  pattern: z.string().optional(),
  taskIdentifier: z.string().optional(),
  fingerprint: z.string().optional(),
});

const AlertCondition = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("threshold"),
    operator: z.enum([">", "<"]),
    value: z.number().finite(),
    windowSec: z.number().int().positive(),
    holdSec: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("state"),
    stateKey: z.string(),
    holdSec: z.number().int().positive().optional(),
    params: z
      .record(z.string(), z.number())
      .optional()
      .describe("Overrides for the capability's param defaults, e.g. thresholds."),
  }),
  z.object({ kind: z.literal("occurrence") }),
  z.object({ kind: z.literal("absence"), quietWindowSec: z.number().int().min(1800) }),
]);

const AlertNotifier = z.discriminatedUnion("type", [
  z.object({ type: z.literal("channel"), channelId: z.string() }),
  z.object({
    type: z.literal("chat"),
    chatId: z.string(),
    userId: z.string().optional(),
  }),
]);

const CreateAlertInput = CommonProjectsInput.extend({
  capabilityKey: z
    .string()
    .describe(
      "The capability key to monitor. Use list_alert_capabilities to discover available keys."
    ),
  params: z
    .object({
      scope: AlertScope.optional().describe("Defaults to all."),
      windowSec: z.number().optional(),
    })
    .describe(
      "The scope for this capability, e.g. { scope: { type: 'queue', queue: 'my-queue' } } or { scope: { type: 'errorGroup', taskIdentifier, fingerprint } }."
    ),
  condition: AlertCondition.describe(
    "The condition that raises the alert, matching the kind returned by list_alert_capabilities for this capability."
  ),
  behavior: z
    .object({
      expiresAt: z.string().describe("ISO 8601 timestamp after which the alert stops.").optional(),
    })
    .describe("Optional expiry. Alerts keep firing until they expire or are stopped."),
  notifiers: z
    .array(AlertNotifier)
    .min(1)
    .describe("Who to notify when the alert raises, e.g. [{ type: 'chat', chatId: '<id>' }]."),
  name: z.string().describe("An optional display name for the alert.").optional(),
});

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
    run: async (input, ctx) => {
      const project = await findMonitoringAlertsProject(input.projectRef!, ctx.identity.userId);
      if (!project) return errorResult("Project not found");
      if (!(await canUseMonitoringAlerts(project, ctx.identity.userId))) {
        return errorResult(NOT_ENABLED);
      }

      const body = MonitoringAlertsCreateBodySchema.safeParse(input);
      if (!body.success) {
        return errorResult(`Invalid request body: ${body.error.issues[0]?.message}`);
      }
      const { condition, capabilityKey } = body.data;
      if (
        capabilityKey === GROUP_CAPABILITY_KEY ||
        capabilityKey === "custom.query" ||
        "memberAlertIds" in condition
      ) {
        return errorResult("This capability cannot be created from this tool");
      }

      const capability = defaultCapabilityLookup(capabilityKey);
      const draftError = validateAlertDraft({
        capability,
        capabilityKey,
        surface: "mcp",
        conditionKind: condition.kind,
        quietWindowSec: condition.kind === "absence" ? condition.quietWindowSec : undefined,
        scope: body.data.params.scope,
        ...stateFields(condition),
      });
      if (draftError) return errorResult(draftError.message);
      if (capability && "params" in condition && condition.params) {
        try {
          validateConditionParams(condition.params, capability.binding.params ?? []);
        } catch (e) {
          return errorResult((e as Error).message);
        }
      }

      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Not authorized");

      const notifierError = await validateAlertNotifiers({
        notifiers: body.data.notifiers,
        projectId: project.id,
        organizationId: project.organizationId,
        userId: ctx.identity.userId,
        environmentType: environment.type,
      });
      if (notifierError) return errorResult(notifierError.message);

      const alert = await createAlertAndSchedule(prisma, {
        organizationId: project.organizationId,
        projectId: project.id,
        environmentId: environment.id,
        createdBy: ctx.identity.userId,
        capabilityKey,
        condition,
        expiresAt: body.data.behavior.expiresAt
          ? new Date(body.data.behavior.expiresAt)
          : undefined,
        notifiers: body.data.notifiers,
        name: body.data.name,
        params: {
          environmentId: environment.id,
          scope: body.data.params.scope,
          windowSec: body.data.params.windowSec,
        },
      });

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
      if (!project) return errorResult("Project not found");
      if (!(await canUseMonitoringAlerts(project, ctx.identity.userId))) {
        return errorResult(NOT_ENABLED);
      }

      const alert = await getAlert(prisma, { id: input.alertId, projectId: project.id });
      if (!alert) return errorResult("Alert not found");

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
        return fencedError("Not authorized", "alert-error");
      }

      const outcome = await resolveAlert(prisma, { id: alert.id, actorId: identity.userId });
      if (!outcome) return errorResult("Alert cannot be resolved from its current state");

      return textResult(`Alert ${outcome.alert.id} resolved.`);
    },
  }),
];
