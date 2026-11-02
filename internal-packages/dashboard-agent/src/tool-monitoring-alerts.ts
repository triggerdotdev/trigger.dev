import { tool, type ToolSet } from "ai";
import { bareFingerprint } from "./tool-read-scope";
import {
  analyzeQueryAlertSchema,
  createMonitoringAlertSchema,
  describeAlertCapabilitiesSchema,
  listMonitoringAlertsSchema,
  resolveMonitoringAlertSchema,
  updateAlertDraftSchema,
} from "./tool-schemas";
import {
  apiGet,
  apiPost,
  NO_AUTH,
  type DashboardAgentApiClient,
  type FetchResult,
} from "./tool-api-client";
import {
  getCapability,
  listCapabilities,
  isScopeAllowed,
  validateConditionParams,
} from "@internal/alert-contracts";
import type { AlertDraftPatch } from "@internal/dashboard-agent-contracts";
import type { DashboardAgentToolContext } from "./tool-context";

function toResult(result: FetchResult): { data: unknown } | { error: string } {
  if (result.ok) return { data: result.data };
  if ("status" in result) {
    const body = result.data as
      | { error?: string; issues?: { path: (string | number)[]; message: string }[] }
      | undefined;
    const error = body?.error ?? `The monitoring alerts API failed (status ${result.status}).`;
    const issues = body?.issues?.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { error: issues ? `${error} (${issues})` : error };
  }
  return { error: `Couldn't reach the monitoring alerts API: ${result.transport}` };
}

function validateDraftPatch(patch: AlertDraftPatch): string[] {
  const errors: string[] = [];
  if (patch.area === "query") {
    if (!patch.query?.trim()) errors.push("a query alert needs query");
    return errors;
  }
  if (patch.condition?.operator === "<") {
    errors.push("Below-threshold alerts aren't supported yet");
  }
  const areas = new Set(listCapabilities({ surface: "agent" }).map((c) => c.area));

  if (patch.area && !areas.has(patch.area)) {
    errors.push(`unknown area: "${patch.area}"`);
  }

  const cap = patch.what ? getCapability(patch.what) : undefined;
  if (patch.what && !cap) {
    errors.push(`unknown capability key: "${patch.what}"`);
  }

  if (cap && patch.scope) {
    if (!isScopeAllowed(cap, patch.scope.type)) {
      errors.push(`scope type "${patch.scope.type}" not allowed for ${cap.key}`);
    }
  }

  if (patch.scope?.type === "errorGroup" && !patch.scope.errorId && !patch.scope.fingerprint) {
    errors.push("errorGroup scope needs errorId or fingerprint");
  }

  if (cap && patch.condition) {
    const { compositeMode, components, signals } = patch.condition;
    const compositeOf = cap.binding.compositeOf;
    if ((compositeMode !== undefined || components !== undefined) && !compositeOf) {
      errors.push(`${cap.key} has no components`);
    }
    const unknown = components?.filter((c) => !compositeOf?.includes(c)) ?? [];
    if (compositeOf && (unknown.length > 0 || components?.length === 0)) {
      errors.push(
        unknown.length
          ? `components not part of ${cap.key}: ${unknown.join(", ")}`
          : "components must not be empty"
      );
    }
    if (signals !== undefined) {
      const supported =
        cap.supportedSignals ??
        (components ?? compositeOf)?.flatMap((key) => getCapability(key)?.supportedSignals ?? []) ??
        [];
      const unsupported = signals.filter((s) => !supported.includes(s));
      if (unsupported.length > 0 || signals.length === 0) {
        errors.push(
          unsupported.length
            ? `signals not supported by ${cap.key}: ${unsupported.join(", ")}`
            : "signals must not be empty"
        );
      }
    }
  }

  if (cap && patch.condition?.params) {
    const declared = cap.binding.params ?? [];
    try {
      validateConditionParams(patch.condition.params, declared);
    } catch (e: any) {
      errors.push(e.message);
    }
  }

  return errors;
}

export { validateDraftPatch as _validateDraftPatch };

type OfferedCapability = {
  key: string;
  allowedKinds?: string[];
  params?: Array<{ key: string; default: number }>;
};

function withPrefillActions(data: unknown, ctx: DashboardAgentToolContext): unknown {
  if (ctx.toolScope !== "alert_creation") return data;
  const answers = ctx.alertDraft?.answers;
  if (answers?.conditionParams && Object.keys(answers.conditionParams).length > 0) return data;
  const capabilities = (data as { capabilities?: OfferedCapability[] } | undefined)?.capabilities;
  if (!Array.isArray(capabilities)) return data;
  return {
    ...(data as object),
    capabilities: capabilities.map((c) => {
      if (!c.params?.length || !c.allowedKinds?.includes("state")) return c;
      if (answers?.what && answers.what !== c.key) return c;
      return {
        ...c,
        nextAction: {
          tool: "update_alert_draft",
          input: {
            patch: {
              what: c.key,
              condition: {
                kind: "state",
                params: Object.fromEntries(c.params.map((p) => [p.key, p.default])),
              },
            },
          },
          reason:
            "When recommending values for this capability, call this now so the wizard is pre-filled. Do not ask the user.",
        },
      };
    }),
  };
}

export function buildMonitoringAlertTools(args: {
  ctx: DashboardAgentToolContext;
  client: DashboardAgentApiClient;
}): ToolSet {
  const { ctx, client } = args;
  const { userActorToken } = ctx;
  const { origin, hasAuth } = client;

  return {
    describe_alert_capabilities: tool({
      ...describeAlertCapabilitiesSchema,
      execute: async ({ area, curatedOnly }) => {
        if (!hasAuth) return NO_AUTH;
        const params = new URLSearchParams({ capabilities: "true" });
        if (area) params.set("area", area);
        if (curatedOnly) params.set("curatedOnly", "true");
        const result = toResult(
          await apiGet(
            origin,
            `/api/v1/dashboard-agent/monitoring-alerts?${params}`,
            userActorToken!
          )
        );
        if ("error" in result) return result;
        return withPrefillActions(result.data, ctx);
      },
    }),

    create_monitoring_alert: tool({
      ...createMonitoringAlertSchema,
      execute: async ({
        capabilityKey,
        environment,
        name,
        scope,
        condition,
        behavior,
        notifiers,
        query,
        signal,
      }) => {
        if (!hasAuth) return NO_AUTH;
        if (!ctx.chatId) return { error: "No chat is available to create an alert from." };
        if (scope?.type === "errorGroup" && (!scope.taskIdentifier || !scope.fingerprint)) {
          return {
            error:
              "errorGroup scope needs taskIdentifier and fingerprint (from list_errors/get_error)",
          };
        }
        const result = toResult(
          await apiPost(origin, "/api/v1/dashboard-agent/monitoring-alerts", userActorToken!, {
            chatId: ctx.chatId,
            capabilityKey,
            ...(environment ? { environment } : {}),
            ...(name ? { name } : {}),
            ...(scope
              ? {
                  scope: scope.fingerprint
                    ? { ...scope, fingerprint: bareFingerprint(scope.fingerprint) }
                    : scope,
                }
              : {}),
            condition,
            ...(behavior ? { behavior } : {}),
            ...(notifiers ? { notifiers } : {}),
            ...(query ? { query } : {}),
            ...(signal ? { signal } : {}),
          })
        );
        if ("error" in result) return result;
        return result.data;
      },
    }),

    update_alert_draft: tool({
      ...updateAlertDraftSchema,
      execute: async ({ patch, reason }) => {
        const errors = validateDraftPatch(patch);
        if (errors.length > 0) return { ok: false, errors };
        return { ok: true, patch, ...(reason ? { reason } : {}) };
      },
    }),

    list_monitoring_alerts: tool({
      ...listMonitoringAlertsSchema,
      execute: async ({ attention, lifecycle }) => {
        if (!hasAuth) return NO_AUTH;
        if (!ctx.chatId) return { error: "No chat is available to list alerts from." };
        const params = new URLSearchParams({ chatId: ctx.chatId });
        if (attention) params.set("attention", attention);
        if (lifecycle) params.set("lifecycle", lifecycle);
        const result = toResult(
          await apiGet(
            origin,
            `/api/v1/dashboard-agent/monitoring-alerts?${params}`,
            userActorToken!
          )
        );
        if ("error" in result) return result;
        const alerts = (result.data as { alerts?: unknown } | undefined)?.alerts;
        return { alerts: Array.isArray(alerts) ? alerts : [] };
      },
    }),

    resolve_monitoring_alert: tool({
      ...resolveMonitoringAlertSchema,
      execute: async ({ alertId }) => {
        if (!hasAuth) return NO_AUTH;
        if (!ctx.chatId) return { error: "No chat is available to resolve an alert from." };
        const result = toResult(
          await apiPost(origin, "/api/v1/dashboard-agent/monitoring-alerts", userActorToken!, {
            chatId: ctx.chatId,
            alertId,
          })
        );
        if ("error" in result) return result;
        return result.data;
      },
    }),
  };
}

/** Attached after submit_feedback: the tool key order is the cached prompt prefix. */
export function buildAnalyzeQueryAlertTool(args: {
  ctx: DashboardAgentToolContext;
  client: DashboardAgentApiClient;
}): ToolSet {
  const { userActorToken } = args.ctx;
  const { origin, hasAuth } = args.client;

  return {
    analyze_query_alert: tool({
      ...analyzeQueryAlertSchema,
      execute: async ({ query }) => {
        if (!hasAuth) return NO_AUTH;
        const result = toResult(
          await apiPost(
            origin,
            "/api/v1/dashboard-agent/monitoring-alerts/analyze-query",
            userActorToken!,
            { query }
          )
        );
        if ("error" in result) return result;
        return result.data;
      },
    }),
  };
}
