import type { AlertArea, AlertCapability, CapabilityParam } from "@internal/alert-contracts";
import { listCapabilities } from "@internal/alert-contracts";
import { AREA_ICON, AREA_LABEL } from "~/components/alerts/domainIcons";
import type { QueryAlertMode } from "~/components/alerts/queryAlertLink";
import type { RenderIcon } from "~/components/primitives/Icon";
import { formatNumber } from "~/utils/numberFormatter";
import {
  encodeErrorGroupScope,
  errorGroupLabel,
  parseErrorGroupScope,
  type ErrorGroupScope,
} from "~/utils/errorGroupScope";

export type FlowStepKey = "area" | "what" | "scope" | "condition" | "environments" | "notifiers";

export type FlowChip = { value: string; label: string; icon?: RenderIcon; description?: string };

export type FlowAnswers = {
  area?: AlertArea;
  what?: string;
  scope?: string;
  scopeValue?: string;
  condition?: string;
  conditionParams?: Record<string, number>;
  windowMinutes?: number;
  notifiers?: string[];
  expiry?: string;
  replace?: ReplaceTarget;
  environments?: string[];
  environmentsConfirmed?: boolean;
  previewsExpanded?: boolean;
};

export type ReplaceEnvironment = {
  id: string;
  type: string;
  slug: string;
  branchName: string | null;
};

type ReplaceTarget = {
  channelId: string;
  channelName: string;
  alertType: string;
  environments: ReplaceEnvironment[];
};

export const STEP_ORDER: FlowStepKey[] = [
  "area",
  "what",
  "condition",
  "scope",
  "environments",
  "notifiers",
];

const REPLACE_CAPABILITY = "runs.failed";

function defaultEnvironmentIds(environments: ReplaceEnvironment[]): string[] {
  return environments.filter((env) => env.type !== "PREVIEW").map((env) => env.id);
}

export function replacePrefill(
  row: { channelId: string; channelName: string; alertType: string },
  environments: ReplaceEnvironment[]
): DraftPrefillParams {
  return {
    capability: REPLACE_CAPABILITY,
    scope: "all",
    replace: {
      channelId: row.channelId,
      channelName: row.channelName,
      alertType: row.alertType,
      environments,
    },
  };
}

export function areaChips(): FlowChip[] {
  const seen = new Set<string>();
  const chips: FlowChip[] = [];
  for (const cap of listCapabilities({ surface: "agent" })) {
    if (!seen.has(cap.area)) {
      seen.add(cap.area);
      chips.push({
        value: cap.area,
        label: AREA_LABEL[cap.area as keyof typeof AREA_LABEL] ?? cap.area,
        icon: AREA_ICON[cap.area as keyof typeof AREA_ICON],
      });
    }
  }
  return chips;
}

const CAPABILITY_PHRASE: Record<string, string> = {
  "queue.depth": "Depth getting too high",
  "queue.oldest_age": "Oldest run waiting too long",
  "queue.concurrency": "Concurrency usage spiking",
  "queue.stalled": "A queue stalling",
  "queue.scheduling_delay_p95": "Scheduling delay climbing",
  "runs.volume": "Run volume changing",
  "runs.duration_p95": "Runs taking too long",
  "runs.created": "Runs going quiet",
  "runs.failure_rate": "Failure rate climbing",
  "runs.failed": "Any run failing",
  "health.flow": "Flow health degrading",
  "health.execution": "Execution health degrading",
  "health.liveness": "Tasks going silent",
  "health.all": "Overall health check",
  "errors.new": "A new error appearing",
  "errors.occurred_again": "This error occurring again",
};

function capabilityPhrase(key: string): string {
  return CAPABILITY_PHRASE[key] ?? resolveCapability(key)?.title ?? key;
}

export function capabilityChips(area: string | undefined): FlowChip[] {
  if (!area) return [];
  const caps = listCapabilities({ area, surface: "agent" });
  return caps.map((cap) => ({
    value: cap.key,
    label: capabilityPhrase(cap.key),
    description: cap.description,
  }));
}

export function resolveCapability(key: string | undefined): AlertCapability | undefined {
  if (!key) return undefined;
  return listCapabilities().find((c) => c.key === key);
}

export function capabilityParams(key: string | undefined): CapabilityParam[] {
  const params = resolveCapability(key)?.binding?.params ?? [];
  return params.length > 1 ? params.filter((p) => p.key !== "silenceSec") : params;
}

const SCOPE_ALL_LABEL: Record<string, string> = {
  queues: "All queues",
  runs: "All runs",
  health: "All tasks",
  errors: "All errors",
};

export function scopeChipsFor(capabilityKey: string | undefined): FlowChip[] {
  const cap = resolveCapability(capabilityKey);
  if (!cap) return [];
  const chips: FlowChip[] = [];
  const allLabel = SCOPE_ALL_LABEL[cap.area] ?? "All";
  if (cap.allowedScopes.includes("all")) {
    chips.push({ value: "all", label: allLabel });
  }
  for (const scope of cap.allowedScopes) {
    if (scope === "all" || scope === "queuePattern") continue;
    chips.push({ value: scope, label: SCOPE_LABEL[scope] ?? scope });
  }
  return chips;
}

export function lockedScope(capabilityKey: string | undefined): string | undefined {
  const chips = scopeChipsFor(capabilityKey);
  return chips.length === 1 && !needsScopeValue(chips[0]!.value) ? chips[0]!.value : undefined;
}

export function isErrorGroupOnly(capabilityKey: string | undefined): boolean {
  const chips = scopeChipsFor(capabilityKey);
  return chips.length === 1 && chips[0]!.value === "errorGroup";
}

export function skipsScope(answers: FlowAnswers): boolean {
  if (lockedScope(answers.what) !== undefined) return true;
  return isErrorGroupOnly(answers.what) && parseErrorGroupScope(answers.scopeValue) !== undefined;
}

export function withAutoAnswers(answers: FlowAnswers): FlowAnswers {
  const locked = answers.scope === undefined ? lockedScope(answers.what) : undefined;
  if (locked) return { ...answers, scope: locked, scopeValue: undefined };
  if (
    answers.scope === undefined &&
    isErrorGroupOnly(answers.what) &&
    parseErrorGroupScope(answers.scopeValue)
  ) {
    return { ...answers, scope: "errorGroup" };
  }
  return answers;
}

const SCOPE_LABEL: Record<string, string> = {
  queue: "Specific queue",
  queuePattern: "Queue pattern",
  task: "Specific task",
  fingerprint: "Error fingerprint",
  errorGroup: "Error group",
  all: "All",
};

export function scopeEntityKind(scope: string | undefined): "queue" | "task" | undefined {
  return scope === "queue" || scope === "task" ? scope : undefined;
}

export function scopeEntityKindFor(answers: FlowAnswers): "queue" | "task" | undefined {
  return (
    scopeEntityKind(answers.scope) ??
    scopeChipsFor(answers.what)
      .map((chip) => scopeEntityKind(chip.value))
      .find(Boolean)
  );
}

export function needsScopeValue(scope: string | undefined): boolean {
  return scope !== undefined && scope !== "all";
}

export function conditionKindFor(capabilityKey: string | undefined): string | undefined {
  const cap = resolveCapability(capabilityKey);
  if (!cap) return undefined;
  return cap.allowedKinds[0];
}

function needsThreshold(capabilityKey: string | undefined): boolean {
  const kind = conditionKindFor(capabilityKey);
  return kind === "threshold";
}

function needsAbsenceWindow(capabilityKey: string | undefined): boolean {
  const kind = conditionKindFor(capabilityKey);
  return kind === "absence";
}

export const CUSTOM_EXPIRY = "custom";

export const EXPIRY_CHIPS: FlowChip[] = [
  { value: "none", label: "No expiry" },
  { value: "24h", label: "For 24 hours" },
  { value: CUSTOM_EXPIRY, label: "Until…" },
];

export function expiryError(date: Date, now = Date.now()): string | undefined {
  if (date.getTime() <= now) return "Must be in the future";
  return undefined;
}

export function expiryFromDate(date: Date | undefined, now = Date.now()): string | undefined {
  const at = date?.getTime();
  if (!date || at === undefined || Number.isNaN(at) || expiryError(date, now)) return undefined;
  return new Date(at).toISOString();
}

export function isExpiryTimestamp(value: string | undefined): boolean {
  return Boolean(value?.includes("T")) && !Number.isNaN(Date.parse(value!));
}

export function expiryDate(value: string | undefined, now = Date.now()): Date | undefined {
  const hours = value?.match(/^(\d+)h$/);
  if (hours) return new Date(now + Number(hours[1]) * 3_600_000);
  if (!value || !isExpiryTimestamp(value)) return undefined;
  return new Date(value);
}

const EXPIRY_EVENT_LABEL: Record<string, string> = {
  deploy: "until tonight's deploy settles",
  incident: "until the incident is closed",
};

export function expiryLabel(value: string | undefined): string | undefined {
  if (!value || value === "none") return undefined;
  const event = EXPIRY_EVENT_LABEL[value];
  if (event) return event;
  if (isExpiryTimestamp(value)) return `expires ${new Date(value).toLocaleString()}`;
  const hours = value.match(/^(\d+)h?$/);
  return hours ? `expires in ${hours[1]}h` : value;
}

export function defaultWindowMinutes(capabilityKey: string | undefined): number {
  const cap = resolveCapability(capabilityKey);
  return Math.max(1, Math.ceil((cap?.minCadenceSec ?? 300) / 60));
}

function unitSuffix(unit: string | undefined): string {
  if (!unit) return "";
  if (unit === "percent") return "%";
  if (unit === "duration_ms") return "ms";
  if (unit === "rate_per_hour") return "/h";
  return "";
}

export function conditionSuggestionChips(capabilityKey: string | undefined): FlowChip[] {
  const cap = resolveCapability(capabilityKey);
  if (!cap) return [];
  const kind = conditionKindFor(capabilityKey);
  if (kind === "threshold") {
    const suffix = unitSuffix(cap.unit);
    const defaults: Record<string, number[]> = {
      count: [50, 100, 200],
      duration_ms: [1000, 5000, 10000],
      percent: [50, 75, 90],
      rate_per_hour: [10, 50, 100],
    };
    const values = defaults[cap.unit ?? "count"] ?? [50, 100, 200];
    return values.map((v) => ({
      value: String(v),
      label: `${formatNumber(v)}${suffix}`,
    }));
  }
  if (kind === "absence") {
    return [
      { value: "30", label: "30m" },
      { value: "60", label: "60m" },
      { value: "120", label: "120m" },
    ];
  }
  return [];
}

export function paramSuggestionChips(param: CapabilityParam): FlowChip[] {
  const d = param.default;
  const unit = param.unit === "ms" ? "ms" : param.unit === "seconds" ? "s" : "";
  const base = [Math.round(d * 0.5), d, Math.round(d * 2)].filter(
    (v) => v >= (param.min ?? 0) && (param.max === undefined || v <= param.max)
  );
  const unique = [...new Set(base)];
  return unique.map((v) => ({
    value: String(v),
    label: `${formatNumber(v)}${unit}`,
  }));
}

function chipsForStep(key: FlowStepKey, answers: FlowAnswers): FlowChip[] {
  switch (key) {
    case "area":
      return areaChips();
    case "what":
      return capabilityChips(answers.area);
    case "scope":
      return scopeChipsFor(answers.what);
    case "condition":
    case "environments":
    case "notifiers":
      return [];
  }
}

export function conditionStem(capabilityKey: string | undefined): string | undefined {
  const stem = CONDITION_STEM[capabilityKey ?? ""];
  return stem ? `when ${stem}` : undefined;
}

const CONDITION_STEM: Record<string, string> = {
  "queue.depth": "queue depth gets higher than…",
  "queue.oldest_age": "the oldest queued run has waited longer than…",
  "queue.concurrency": "queue concurrency gets higher than…",
  "queue.scheduling_delay_p95": "p95 scheduling delay gets longer than…",
  "runs.volume": "run volume gets higher than…",
  "runs.duration_p95": "p95 run duration gets longer than…",
  "runs.created": "no runs are created for longer than…",
  "runs.failure_rate": "the failure rate gets higher than…",
  "runs.failed": "failed runs get higher than…",
  "health.flow": "flow health crosses any of these thresholds:",
  "health.execution": "execution health crosses any of these thresholds:",
  "health.liveness": "tasks stay silent for longer than…",
  "health.all": "overall health crosses any of these thresholds:",
};

const ERROR_SCOPE_PROMPT = "Which error should this alert watch?";

const SCOPE_PROMPT: Record<string, string> = {
  queues: "Which queues should this alert cover?",
  runs: "Which tasks should this alert cover?",
  errors: ERROR_SCOPE_PROMPT,
};

export function promptForStep(key: FlowStepKey, answers: FlowAnswers): string {
  switch (key) {
    case "area":
      return "What should Trigger watch?";
    case "what": {
      const areaLabel = answers.area
        ? (AREA_LABEL[answers.area as keyof typeof AREA_LABEL] ?? answers.area)
        : "";
      return `What about ${areaLabel.toLowerCase()}?`;
    }
    case "scope":
      return SCOPE_PROMPT[answers.area ?? ""] ?? "What should this alert cover?";
    case "condition":
      return "When should this alert fire?";
    case "environments":
      return "Which environments should it watch?";
    case "notifiers":
      return "Where should it notify you?";
  }
}

export function labelFor(
  key: FlowStepKey,
  value: string | undefined,
  answers: FlowAnswers
): string {
  if (!value) return "";
  const chips = chipsForStep(key, answers);
  if (key === "scope" && value === "errorGroup") return errorGroupLabel(answers.scopeValue);
  const found = chips.find((c) => c.value === value);
  if (found) return found.label;
  return value;
}

export function conditionSummary(answers: FlowAnswers): string {
  const cap = resolveCapability(answers.what);
  if (!cap) return "";
  const kind = conditionKindFor(answers.what);
  if (kind === "threshold" && answers.condition) {
    const unit = cap.unit ?? "";
    return `${cap.title} > ${formatValue(answers.condition)}${UNIT_SUFFIX[unit] ?? ""}`;
  }
  if (kind === "absence" && answers.condition) {
    return `No ${cap.title.toLowerCase()} for ${formatValue(answers.condition)}m`;
  }
  if (kind === "state") return cap.title;
  if (kind === "occurrence") return cap.title;
  return cap.title;
}

function formatValue(text: string): string {
  const n = Number(text);
  return Number.isFinite(n) ? formatNumber(n) : text;
}

const UNIT_SUFFIX: Record<string, string> = {
  count: "",
  duration_ms: "ms",
  percent: "%",
  rate_per_hour: "/h",
};

const ALERT_NAME_MAX = 120;

export function alertName(answers: FlowAnswers): string {
  const name = buildAlertName(answers);
  return name.length > ALERT_NAME_MAX ? `${name.slice(0, ALERT_NAME_MAX - 1)}…` : name;
}

function buildAlertName(answers: FlowAnswers): string {
  const cap = resolveCapability(answers.what);
  if (!cap) return "New alert";
  const phrase = capabilityPhrase(cap.key);
  const kind = conditionKindFor(answers.what);
  const scopeLabel =
    answers.scope === "all"
      ? (SCOPE_ALL_LABEL[cap.area] ?? "all").toLowerCase()
      : (answers.scopeValue ?? "");
  if (kind === "threshold" && answers.condition) {
    const suffix = UNIT_SUFFIX[cap.unit ?? ""] ?? "";
    const base = `${cap.title} above ${answers.condition}${suffix}`;
    return scopeLabel ? `${base} on ${scopeLabel}` : base;
  }
  if (kind === "absence" && answers.condition) {
    const base = `No ${cap.title.toLowerCase()} for ${answers.condition}m`;
    return scopeLabel ? `${base} on ${scopeLabel}` : base;
  }
  if (kind === "occurrence" && answers.scope === "errorGroup") {
    return `${phrase} · ${errorGroupLabel(answers.scopeValue)}`;
  }
  return phrase;
}

export function draftMissing(answers: FlowAnswers): FlowStepKey[] {
  const missing: FlowStepKey[] = [];
  if (!answers.area) missing.push("area");
  if (!answers.what) missing.push("what");
  if (needsThreshold(answers.what) && !answers.condition?.trim()) missing.push("condition");
  if (needsAbsenceWindow(answers.what) && !answers.condition?.trim()) missing.push("condition");
  const params = capabilityParams(answers.what);
  if (params.length > 1 && params.some((p) => answers.conditionParams?.[p.key] === undefined)) {
    missing.push("condition");
  }
  if (!answers.scope) missing.push("scope");
  if (needsScopeValue(answers.scope) && !answers.scopeValue?.trim()) missing.push("scope");
  if (answers.scope === "errorGroup" && !parseErrorGroupScope(answers.scopeValue)) {
    missing.push("scope");
  }
  if (answers.replace && (!answers.environmentsConfirmed || !answers.environments?.length)) {
    missing.push("environments");
  }
  return missing;
}

export function isComplete(answers: FlowAnswers): boolean {
  return draftMissing(answers).length === 0;
}

export type DraftPrefillParams = {
  area?: AlertArea;
  capability?: string;
  scope?: string | ErrorGroupScope;
  scopeValue?: string;
  replace?: ReplaceTarget;
  source?: "query";
  query?: string;
  period?: string;
  mode?: QueryAlertMode;
  measure?: string;
};

export function asArea(value: string | undefined): DraftPrefillParams["area"] {
  return value === "queues" || value === "runs" || value === "health" || value === "errors"
    ? value
    : undefined;
}

export function prefillToAnswers(params: DraftPrefillParams): FlowAnswers {
  if (params.replace) {
    return {
      area: resolveCapability(REPLACE_CAPABILITY)?.area,
      what: REPLACE_CAPABILITY,
      condition: "0",
      windowMinutes: defaultWindowMinutes(REPLACE_CAPABILITY),
      scope: "all",
      notifiers: [params.replace.channelId],
      replace: params.replace,
      environments: defaultEnvironmentIds(params.replace.environments),
    };
  }
  const answers: FlowAnswers = {};
  if (params.capability) {
    const cap = resolveCapability(params.capability);
    if (cap) {
      answers.area = cap.area;
      answers.what = params.capability;
    }
  }
  if (!answers.area && params.area) answers.area = params.area;
  if (typeof params.scope === "object") {
    answers.scope = "errorGroup";
    answers.scopeValue = encodeErrorGroupScope(params.scope);
    return answers;
  }
  if (params.scope === "errorGroup" && !parseErrorGroupScope(params.scopeValue)) {
    return answers;
  }
  if (params.scope) {
    answers.scope = params.scope;
  }
  if (params.scopeValue) {
    answers.scopeValue = params.scopeValue;
  }
  return answers;
}

export { prefillToAnswers as searchParamsToAnswers };

const CREATE_PARAMS = ["create", "area", "capability", "scope", "scopeValue"] as const;

export function stripCreateSearchParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of CREATE_PARAMS) next.delete(key);
  return next;
}
