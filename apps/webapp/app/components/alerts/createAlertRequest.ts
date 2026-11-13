import { paramsForComponents } from "@internal/alert-contracts";
import { EXPIRY_TOKEN_PATTERN } from "~/components/alerts/alertCreatedCard";
import {
  alertName,
  defaultWindowMinutes,
  effectiveSignals,
  isLimitCondition,
  isComposite,
  resolveCapability,
  supportedSignalsFor,
  type FlowAnswers,
} from "~/components/dashboard-agent/alert-creation/flow-state";

export const CREATE_ALERT_PATH = "/resources/alerts/create";

const CREATE_FAILED = "Failed to create the alert. Try again.";

export function createAlertErrorMessage(status: number, error: string | undefined): string {
  return (status === 400 || status === 422) && error ? error : CREATE_FAILED;
}

export function expiryToIso(exp: string | undefined): string | undefined {
  if (!exp || exp === "none") return undefined;
  const EVENT_HOURS: Record<string, number> = { deploy: 168, incident: 720 };
  const hoursMatch = exp.match(/^(\d+)h$/);
  const hours = hoursMatch ? Number(hoursMatch[1]) : EVENT_HOURS[exp];
  if (hours) return new Date(Date.now() + hours * 3600_000).toISOString();
  return Number.isNaN(Date.parse(exp)) ? undefined : new Date(exp).toISOString();
}

export function withKnownNotifiers(answers: FlowAnswers, channels: { id: string }[]): FlowAnswers {
  return answers.notifiers
    ? { ...answers, notifiers: answers.notifiers.filter((id) => channels.some((c) => c.id === id)) }
    : answers;
}

export function replaceRequestBody(answers: FlowAnswers): FormData {
  const target = answers.replace!;
  const expiresAt = expiryToIso(answers.expiry);
  const body = new FormData();
  body.set("intent", "replace");
  body.set("channelId", target.channelId);
  body.set("alertType", target.alertType);
  body.set("environmentIds", (answers.environments ?? []).join(","));
  body.set("value", answers.condition ?? "0");
  if (answers.windowMinutes) body.set("windowMinutes", String(answers.windowMinutes));
  if (expiresAt) body.set("expiresAt", expiresAt);
  if (answers.scope) body.set("scopeType", answers.scope);
  if (answers.scopeValue) body.set("scopeValue", answers.scopeValue);
  body.set("notifierChannelIds", (answers.notifiers ?? []).join(","));
  return body;
}

function limitFields(answers: FlowAnswers) {
  const cap = resolveCapability(answers.what);
  const params = answers.conditionParams;
  if (cap?.area === "health" && isComposite(answers.what)) {
    const keys = paramsForComponents(cap, answers.components ?? cap.binding.compositeOf ?? []).map(
      (p) => p.key
    );
    return {
      conditionParams:
        params && Object.fromEntries(Object.entries(params).filter(([k]) => keys.includes(k))),
      signals: undefined,
      compositeMode: answers.compositeMode,
      components: answers.components,
    };
  }
  const composite = isComposite(answers.what);
  if (!cap || !isLimitCondition(answers.what)) {
    return composite
      ? {
          conditionParams: params,
          compositeMode: answers.compositeMode ?? "any",
          components: answers.components,
        }
      : { conditionParams: params };
  }
  const hasSignals = supportedSignalsFor(answers.what, answers.components).length > 0;
  const signals = hasSignals ? effectiveSignals(answers) : undefined;
  const { utilisationPct, ...rest } = params ?? {};
  const pct =
    utilisationPct ?? cap.binding.params?.find((p) => p.key === "utilisationPct")?.default;
  const conditionParams =
    signals?.includes("approaching") && pct !== undefined
      ? { ...rest, utilisationPct: pct }
      : params
        ? rest
        : undefined;
  return {
    conditionParams,
    signals,
    compositeMode: composite ? (answers.compositeMode ?? "any") : undefined,
    components: composite ? answers.components : undefined,
  };
}

export type QueryAlertChatRequest = { transcriptChatId: string; planItemKey?: string };

function chatRequestFields(chat: QueryAlertChatRequest | undefined) {
  return { transcriptChatId: chat?.transcriptChatId, planItemKey: chat?.planItemKey };
}

export function createAlertRequestBody(
  ids: { organizationId: string; projectId: string; environmentId: string },
  answers: FlowAnswers,
  chat?: QueryAlertChatRequest
) {
  const kind = resolveCapability(answers.what)?.allowedKinds[0] ?? "threshold";
  return {
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    environmentId: ids.environmentId,
    name: alertName(answers),
    ...chatRequestFields(chat),
    expiry:
      answers.expiry && EXPIRY_TOKEN_PATTERN.test(answers.expiry) ? answers.expiry : undefined,
    form: {
      capabilityKey: answers.what,
      scopeType: answers.scope,
      scopeValue: answers.scopeValue,
      conditionKind: kind,
      operator: kind === "threshold" ? ">" : undefined,
      value: answers.condition ? Number(answers.condition) : undefined,
      windowMinutes:
        kind === "threshold"
          ? (answers.windowMinutes ?? defaultWindowMinutes(answers.what))
          : undefined,
      quietWindowMinutes:
        kind === "absence" && answers.condition ? Number(answers.condition) : undefined,
      ...(kind === "state" ? limitFields(answers) : {}),
      expiresAt: expiryToIso(answers.expiry),
      notifierChannelIds: answers.notifiers ?? [],
    },
  };
}

export type QueryAlertDraft = {
  query: string;
  name: string;
  mode: "threshold" | "absence" | "match";
  measure?: string;
  operator: ">" | "<";
  value?: number;
  windowMinutes: number;
  expiry?: string;
  notifiers: string[];
};

export function queryAlertRequestBody(
  ids: { organizationId: string; projectId: string; environmentId: string },
  draft: QueryAlertDraft,
  chat?: QueryAlertChatRequest
) {
  const conditionKind =
    draft.mode === "match" ? "occurrence" : draft.mode === "absence" ? "absence" : "threshold";
  return {
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    environmentId: ids.environmentId,
    name: draft.name,
    ...chatRequestFields(chat),
    expiry: draft.expiry && EXPIRY_TOKEN_PATTERN.test(draft.expiry) ? draft.expiry : undefined,
    form: {
      capabilityKey: "custom.query",
      scopeType: "all",
      conditionKind,
      operator: draft.mode === "threshold" ? draft.operator : undefined,
      value: draft.mode === "threshold" ? draft.value : undefined,
      windowMinutes: draft.mode === "threshold" ? draft.windowMinutes : undefined,
      quietWindowMinutes: draft.mode === "absence" ? draft.windowMinutes : undefined,
      query: draft.query,
      querySignalChoice: {
        mode: draft.mode,
        measure: draft.mode === "match" ? undefined : draft.measure,
      },
      expiresAt: expiryToIso(draft.expiry),
      notifierChannelIds: draft.notifiers,
    },
  };
}
