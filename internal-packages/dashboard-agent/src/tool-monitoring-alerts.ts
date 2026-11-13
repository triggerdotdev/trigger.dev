import { tool, type ToolSet } from "ai";
import {
  analyzeQueryAlertSchema,
  describeAlertCapabilitiesSchema,
  listMonitoringAlertsSchema,
  planDecisionSchema,
  planMonitoringSchema,
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
import type { LimitSignal } from "@internal/alert-contracts";
import {
  monitoringPlanDraftGaps,
  type AlertDraftPatch,
  type PlanDecisionOutput,
} from "@internal/dashboard-agent-contracts";
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

function supportedSignalsOf(
  cap: NonNullable<ReturnType<typeof getCapability>>,
  components?: string[]
): LimitSignal[] {
  if (cap.supportedSignals) return cap.supportedSignals;
  const keys = components ?? cap.binding.compositeOf ?? [];
  return (["approaching", "limited"] as const).filter((s) =>
    keys.some((k) => getCapability(k)?.supportedSignals?.includes(s))
  );
}

/** Drops signals the capability can't raise; an empty result falls back to the wizard default. */
function normalizePlanDraft(draft: AlertDraftPatch): AlertDraftPatch {
  const cap = draft.what ? getCapability(draft.what) : undefined;
  if (draft.area === "query") {
    const { condition: c, querySignalChoice: choice } = draft;
    if (!c || !choice || (c.operator === undefined && c.value === undefined)) return draft;
    return {
      ...draft,
      querySignalChoice: { ...choice, mode: "threshold" },
      condition: { ...c, kind: "threshold" },
    };
  }
  if (!cap) return draft;
  const kind = cap.allowedKinds[0];
  const defaulted: AlertDraftPatch["condition"] =
    kind === "state" || kind === "occurrence"
      ? { kind, ...(cap.binding.compositeOf ? { compositeMode: "any" as const } : {}) }
      : undefined;
  const condition = draft.condition ?? defaulted;
  if (!condition) return draft;
  if (!draft.condition) draft = { ...draft, condition };
  const supported = supportedSignalsOf(cap, condition.components);
  if (supported.length === 0 && condition.signals === undefined) return draft;
  const parts = cap.binding.compositeOf
    ? (condition.components ?? cap.binding.compositeOf)
    : [cap.key];
  const approachingRequired = !parts.every((k) =>
    getCapability(k)?.supportedSignals?.includes("limited")
  );
  const kept = (condition.signals ?? []).filter((s) => supported.includes(s));
  const signals = kept.length
    ? supported.filter((s) => kept.includes(s) || (s === "approaching" && approachingRequired))
    : supported.filter(
        (s) =>
          s === "limited" ||
          (s === "approaching" &&
            (approachingRequired || condition.params?.utilisationPct !== undefined))
      );
  return { ...draft, condition: { ...condition, signals: signals.length ? signals : undefined } };
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
      const supported = supportedSignalsOf(cap, components);
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

/** Condition fields a plan item needs for its capability's kind to be created as proposed. */
function planConditionGaps(draft: AlertDraftPatch): string[] {
  if (draft.area === "query") {
    return draft.querySignalChoice?.mode === "threshold" && draft.condition?.value === undefined
      ? ["condition.value"]
      : [];
  }
  if (!draft.what) return [];
  const kind = getCapability(draft.what)?.allowedKinds[0];
  const condition = draft.condition ?? {};
  if (kind === "threshold") {
    return [
      ...(condition.operator ? [] : ["condition.operator"]),
      ...(condition.value === undefined ? ["condition.value"] : []),
    ];
  }
  if (kind === "absence") return condition.windowSec === undefined ? ["condition.windowSec"] : [];
  return [];
}

// Mirrors the review card: no scope falls back to "all" only when the capability allows it,
// and a task/queue scope without its value leaves the card disabled.
function planScopeGaps(draft: AlertDraftPatch): string[] {
  if (draft.area === "query" || !draft.what) return [];
  const cap = getCapability(draft.what);
  if (!cap) return [];
  const type = draft.scope?.type ?? (cap.allowedScopes.includes("all") ? "all" : undefined);
  const needsValue = type !== undefined && type !== "all" && type !== "errorGroup";
  const scope = draft.scope;
  const errorGroupIncomplete =
    type === "errorGroup" && !(scope?.taskIdentifier && (scope.fingerprint || scope.errorId));
  if (type && !errorGroupIncomplete && !(needsValue && !scope?.value?.trim())) return [];
  const kind = type ?? cap.allowedScopes[0];
  const label = { queuePattern: "a queue pattern", errorGroup: "an error" }[kind as string];
  return [`pick ${label ?? `a ${kind}`} (scope)`];
}

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

    ...(ctx.toolScope === "alert_creation"
      ? {
          update_alert_draft: tool({
            ...updateAlertDraftSchema,
            execute: async ({ patch, reason }) => {
              const errors = validateDraftPatch(patch);
              if (errors.length > 0) return { ok: false, errors };
              return { ok: true, patch, ...(reason ? { reason } : {}) };
            },
          }),
        }
      : {}),

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

const SPIKE_WORDS = /spike|too many|(?<!\bno |\bnot )more than|piling|surge/i;
const ABSENCE_WORDS =
  /\b(no|zero|without)\b.*\b(runs?|activity|events?|triggers?)\b|\b(inactiv|silen|absen|stopped|stalled|idle)/i;

const STANDALONE_NUMBER = /(?<![a-z0-9_./-])\d+(\.\d+)?(%|ms|s|m|h|d)?(?![a-z0-9])/i;

function directionProblem(item: { title: string; summary?: string; draft: AlertDraftPatch }) {
  const text = `${item.title} ${item.summary ?? ""}`;
  return item.draft.area === "query" &&
    item.draft.querySignalChoice?.mode === "absence" &&
    !ABSENCE_WORDS.test(text) &&
    SPIKE_WORDS.test(text)
    ? ["the item is about a spike but its condition is absence; use threshold above a count"]
    : [];
}

function planItemSummary(draft: AlertDraftPatch): string {
  if (draft.area === "query") {
    const choice = draft.querySignalChoice;
    return ["custom.query", [choice?.mode, choice?.measure].filter(Boolean).join(" ")].join(" · ");
  }
  const c = draft.condition;
  const condition = [c?.kind, c?.operator, c?.value].filter((v) => v !== undefined).join(" ");
  const scope = draft.scope
    ? [draft.scope.type, draft.scope.value ?? draft.scope.taskIdentifier].filter(Boolean).join(" ")
    : "all";
  return [draft.what, condition, scope].filter(Boolean).join(" · ").slice(0, 60);
}

/** Attached after analyze_query_alert: the tool key order is the cached prompt prefix. */
export function buildPlanMonitoringTool(args: {
  ctx: DashboardAgentToolContext;
  client: DashboardAgentApiClient;
}): ToolSet {
  const { userActorToken } = args.ctx;
  const { origin, hasAuth } = args.client;

  // The server decides whether the signal fits the query; this only forwards its verdict.
  async function queryProblem(draft: AlertDraftPatch): Promise<string | null> {
    if (!hasAuth) return NO_AUTH.error;
    const result = toResult(
      await apiPost(
        origin,
        "/api/v1/dashboard-agent/monitoring-alerts/analyze-query",
        userActorToken!,
        { query: draft.query, signal: draft.querySignalChoice }
      )
    );
    if ("error" in result) return result.error;
    const signal = (result.data as { signal?: { ok: boolean; message?: string } } | undefined)
      ?.signal;
    if (!signal) return "The query couldn't be checked.";
    return signal.ok ? null : (signal.message ?? "This query can't back an alert.");
  }

  return {
    plan_monitoring: tool({
      ...planMonitoringSchema,
      execute: async (plan) => {
        const seen = new Set<string>();
        const items = plan.items.map((item) => ({
          ...item,
          draft: normalizePlanDraft(item.draft),
        }));
        const errors = await Promise.all(
          items.map(async (item) => {
            const { id, draft } = item;
            const problems = [
              ...(seen.has(id) ? ["duplicate id"] : []),
              ...directionProblem(item),
              ...(item.summary && STANDALONE_NUMBER.test(item.summary)
                ? ["summary must not contain numbers; put values in condition"]
                : []),
              ...(item.detail && STANDALONE_NUMBER.test(item.detail)
                ? ["detail must not contain numbers; put values in condition"]
                : []),
              ...[...monitoringPlanDraftGaps(draft), ...planConditionGaps(draft)].map(
                (field) => `missing ${field}`
              ),
              ...planScopeGaps(draft),
              ...validateDraftPatch(draft),
            ];
            seen.add(id);
            if (problems.length === 0 && draft.area === "query") {
              const problem = await queryProblem(draft);
              if (problem) problems.push(problem);
            }
            return problems.length ? { id, message: problems.join("; ") } : null;
          })
        );
        const failed = errors.filter((e) => e !== null);
        if (failed.length > 0) {
          return {
            ok: false,
            errors: failed,
            retry: "Fix and call plan_monitoring again; do not tell the user about this.",
          };
        }
        return {
          ok: true,
          plan: {
            ...plan,
            environmentId: args.ctx.environmentId,
            items: items.map((item) => ({
              ...item,
              summary: item.summary ?? planItemSummary(item.draft),
            })),
          },
        };
      },
    }),
    plan_decision: tool({
      ...planDecisionSchema,
      execute: async ({ decision }): Promise<PlanDecisionOutput> => ({ ok: true, decision }),
    }),
  };
}
