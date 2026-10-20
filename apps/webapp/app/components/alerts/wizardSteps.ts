import type { CapabilityParam } from "@internal/alert-contracts";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { createElement } from "react";
import { EnvironmentIcon, environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import type { ErrorGroupOption } from "~/components/alerts/errorGroupOptions";
import { queueLabel } from "~/components/alerts/ScopeEntitiesLoader";
import type { ReviewCardFields } from "~/components/alerts/creationCards";
import {
  createdCardFields,
  fullConditionSummary,
  type CreatedCardFields,
} from "~/components/alerts/alertCreatedCard";
import type { ChatWizardInput, ChatWizardStep } from "~/components/dashboard-agent/ChatWizardCard";
import {
  notifyLabel,
  type CreationFlowState,
  type AlertChannel,
} from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  areaChips,
  capabilityChips,
  capabilityParams,
  conditionKindFor,
  conditionSuggestionChips,
  CUSTOM_EXPIRY,
  EXPIRY_CHIPS,
  expiryDate,
  expiryFromDate,
  isComplete,
  alertName,
  labelFor,
  paramSuggestionChips,
  promptForStep,
  isErrorGroupOnly,
  resolveCapability,
  scopeEntityKindFor,
  conditionStem,
  scopeChipsFor,
  skipsScope,
  type FlowAnswers,
  type FlowChip as FlowChipType,
  type FlowStepKey,
  type ReplaceEnvironment,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import {
  encodeErrorGroupScope,
  errorGroupLabel,
  parseErrorGroupScope,
} from "~/utils/errorGroupScope";

export const CHAT_CHIP: FlowChipType = { value: "chat", label: "This chat" };
export const SHOW_ALL_CHIP: FlowChipType = {
  value: "__show_all__",
  label: "Show me what I can watch",
};

export const SCOPE_VALUE_LABEL: Record<string, string> = {
  queue: "Queue",
  queuePattern: "Pattern (e.g. worker-*)",
  task: "Task",
  fingerprint: "Error fingerprint",
  errorGroup: "Error group",
};

function proseForStep(key: FlowStepKey, answers: FlowAnswers): string {
  switch (key) {
    case "area":
      return "What would you like me to watch?";
    case "what": {
      const a = answers.area;
      const areaLabel =
        a === "queues"
          ? "Queues"
          : a === "runs"
            ? "Runs"
            : a === "health"
              ? "Health"
              : a === "errors"
                ? "Errors"
                : (a ?? "");
      return `In ${areaLabel} I can watch`;
    }
    case "scope":
      return promptForStep("scope", answers);
    case "condition":
      return promptForStep("condition", answers);
    case "environments":
      return promptForStep("environments", answers);
    case "notifiers":
      return "Last thing — where should I tell you?";
  }
}

export function buildReviewFields(
  flow: CreationFlowState,
  channels: AlertChannel[],
  environmentTitle?: string
): ReviewCardFields | null {
  if (!isComplete(flow.answers)) return null;
  return {
    name: alertName(flow.answers),
    conditionSummary: fullConditionSummary(flow.answers),
    scopeLabel: labelFor("scope", flow.answers.scope, flow.answers),
    scopeValue: flow.answers.scope === "errorGroup" ? undefined : flow.answers.scopeValue,
    environmentTitle,
    behavior: "recurring",
    notifyLabel: notifyLabel(flow.answers, channels),
  };
}

export function buildCreatedFields(
  flow: CreationFlowState,
  channels: AlertChannel[],
  environmentTitle?: string
): CreatedCardFields | null {
  return createdCardFields(flow.answers, channels, undefined, environmentTitle);
}

export type CardStepId = FlowStepKey | "expiry";

const CARD_STEPS: CardStepId[] = [
  "area",
  "what",
  "condition",
  "scope",
  "environments",
  "expiry",
  "notifiers",
];
export const PREVIEW_GROUP = "__preview__";
const REPLACE_LOCKED = "Fixed when replacing a legacy alert";
const ENVIRONMENTS_DESCRIPTION =
  "Replace creates one alert per environment. Pick the environments to watch.";
const NO_ERROR_GROUPS = "No error groups in the last 7 days";

export type ErrorGroupChoices = {
  groups: ErrorGroupOption[] | undefined;
  /** Resolves a typed `error_…` id or fingerprint and sets it as the scope. */
  lookup?: (id: string) => void;
  lookupError?: string;
};

const ERROR_ID_PLACEHOLDER = "error_… or fingerprint";
const ERROR_ID_OPTION = "__error_id__";
const CUSTOM_SCOPE = "__custom_scope__";
export const CONTINUE_OPTION = "__continue__";
const FILL_THRESHOLDS = "Set every threshold to continue";
export const NO_NOTIFIER = "Pick at least one destination.";
const INCOMPLETE_DRAFT = "Answer every step before saving.";
export const CARD_GAP = 8;
const PARAM_OPTION = "param:";
const NOTIFIERS_DESCRIPTION =
  "Only channels enabled for this environment are listed. Missing one? Check the channels list.";
const EXPIRY_DESCRIPTION = "The alert stops checking once it expires.";

const UNIT_LABEL: Record<string, string> = {
  ms: "ms",
  duration_ms: "ms",
  seconds: "s",
  percent: "%",
  rate_per_hour: "runs/h",
  count: "runs",
};

const MULTI_PARAM_DESCRIPTION = "Fires when any of these values goes above its threshold.";

function stemSentence(what: string | undefined): string | undefined {
  const stem = conditionStem(what);
  return stem ? `Fires ${stem.replace(/…$/, " the threshold").replace(/:$/, "")}.` : undefined;
}

function numberParse(min: number, max?: number) {
  return (text: string) => {
    const n = Number(text.trim());
    if (!text.trim() || !Number.isFinite(n) || n < min) return undefined;
    if (max !== undefined && n > max) return undefined;
    return String(n);
  };
}

function paramInput(
  param: CapabilityParam,
  current: number | undefined,
  onSubmit: (value: number) => void,
  live = false,
  onClear?: () => void
): ChatWizardInput {
  return {
    id: param.key,
    live,
    current: current === undefined ? undefined : String(current),
    label: param.label,
    unit: UNIT_LABEL[param.unit ?? "count"],
    rule: { min: param.min ?? 0, max: param.max, allowZero: param.unit === "count" },
    placeholder: String(param.default),
    ariaLabel: `${param.label} threshold`,
    numeric: true,
    parse: numberParse(param.min ?? 0, param.max),
    onSubmit: (value) => onSubmit(Number(value)),
    onClear,
  };
}

export function scenarioStep(hiddenAreas: string[] = []): ChatWizardStep {
  return {
    id: "scenarios",
    question: "What can I watch?",
    allowSkip: false,
    options: areaChips()
      .filter((area) => !hiddenAreas.includes(area.value))
      .flatMap((area) =>
        capabilityChips(area.value).map((chip) => ({
          id: `${area.value}:${chip.value}`,
          label: `${area.label} · ${chip.label}`,
          icon: area.icon,
          description: chip.description,
        }))
      ),
  };
}

export function cardPosition(flow: CreationFlowState): CardStepId | undefined {
  const step = flow.currentStep;
  if (step === "notifiers" && flow.answers.expiry === undefined) return "expiry";
  return step;
}

function hasConditionStep(what: string | undefined): boolean {
  const kind = conditionKindFor(what);
  return kind === "threshold" || kind === "absence" || capabilityParams(what).length > 0;
}

function toOptions(chips: FlowChipType[]) {
  return chips.map((chip) => ({
    id: chip.value,
    label: chip.label,
    icon: chip.icon,
    description: chip.description,
  }));
}

export type AddChannelAccess = {
  projectId: string;
  canWrite: boolean;
  atLimit: boolean;
  onCreated?: () => void;
};

export const ADD_CHANNEL_OPTION = "__add_channel__";

function addChannelOption(access: AddChannelAccess) {
  return {
    id: ADD_CHANNEL_OPTION,
    label: "Add channel",
    cardLabel: "Add channel…",
    trailingIcon: null,
    disabledReason: !access.canWrite
      ? "You don't have permission to add channels"
      : access.atLimit
        ? "This project is at its channel limit"
        : undefined,
  };
}

function usableCapability(area: string | undefined, what: string, emptyAreas: string[]) {
  if (!area || !emptyAreas.includes(area)) return true;
  return area === "errors" && !isErrorGroupOnly(what);
}

function environmentOption(environment: Pick<ReplaceEnvironment, "type" | "branchName">) {
  const env = {
    type: environment.type as RuntimeEnvironmentType,
    branchName: environment.branchName,
  };
  return {
    label: environmentFullTitle(env),
    icon: createElement(EnvironmentIcon, { environment: env, className: "size-4 shrink-0" }),
  };
}

function environmentsStep(answers: FlowAnswers): ChatWizardStep {
  const envs = answers.replace?.environments ?? [];
  const previews = envs.filter((env) => env.type === "PREVIEW");
  const options: ChatWizardStep["options"] = envs
    .filter((env) => env.type !== "PREVIEW")
    .map((env) => ({ id: env.id, ...environmentOption(env) }));
  if (previews.length) {
    const expanded = Boolean(answers.previewsExpanded);
    options.push({
      id: PREVIEW_GROUP,
      ...environmentOption({ type: "PREVIEW", branchName: null }),
      label: `Preview (${previews.length})`,
      expanded,
    });
    if (expanded) {
      options.push(...previews.map((env) => ({ id: env.id, ...environmentOption(env) })));
    }
  }
  return {
    allowSkip: false,
    id: "environments",
    question: promptForStep("environments", answers),
    description: ENVIRONMENTS_DESCRIPTION,
    options,
    multiSelect: true,
    selected: answers.environments ?? [],
    confirmLabel: "Continue",
  };
}

export function confirmStep(flow: CreationFlowState, stepId: string) {
  if (stepId === "environments") {
    if (flow.answers.environments?.length)
      flow.patchAnswers({ ...flow.answers, environmentsConfirmed: true });
    return;
  }
  flow.confirmNotifiers();
}

function toggleEnvironment(flow: CreationFlowState, value: string) {
  if (value === PREVIEW_GROUP) {
    flow.patchAnswers({ ...flow.answers, previewsExpanded: !flow.answers.previewsExpanded });
    return;
  }
  const current = flow.answers.environments ?? [];
  const next = current.includes(value) ? current.filter((id) => id !== value) : [...current, value];
  flow.patchAnswers({ ...flow.answers, environments: next });
}

export function allSteps(
  flow: CreationFlowState,
  channels: AlertChannel[],
  chatId: string | undefined,
  addChannel?: AddChannelAccess,
  errorGroups?: ErrorGroupChoices,
  scopeEntities?: string[],
  emptyAreas: string[] = [],
  onScopeSearch?: (text: string) => void
): ChatWizardStep[] {
  const { answers } = flow;
  const base = { allowSkip: false };
  const replacing = Boolean(answers.replace);
  const locked = (step: ChatWizardStep): ChatWizardStep =>
    replacing
      ? {
          ...step,
          options: step.options
            .filter((o) => o.id !== SHOW_ALL_CHIP.value)
            .map((o) =>
              step.selected?.includes(o.id) ? o : { ...o, disabledReason: REPLACE_LOCKED }
            ),
        }
      : step;
  return CARD_STEPS.filter((id) => id !== "condition" || hasConditionStep(answers.what))
    .filter((id) => id !== "environments" || replacing)
    .filter((id) => id !== "scope" || !skipsScope(answers) || isErrorGroupOnly(answers.what))
    .map((id): ChatWizardStep => {
      switch (id) {
        case "environments":
          return environmentsStep(answers);
        case "area":
          return locked({
            ...base,
            id,
            question: proseForStep("area", answers),
            options: [
              ...toOptions(
                areaChips().filter(
                  (chip) =>
                    chip.value === answers.area ||
                    capabilityChips(chip.value).some((cap) =>
                      usableCapability(chip.value, cap.value, emptyAreas)
                    )
                )
              ),
              { id: SHOW_ALL_CHIP.value, label: SHOW_ALL_CHIP.label },
            ],
            selected: answers.area ? [answers.area] : [],
          });
        case "what":
          return locked({
            ...base,
            id,
            question: answers.area ? promptForStep("what", answers) : "What should it watch?",
            selectedDescription: resolveCapability(answers.what)?.description,
            options: toOptions([
              ...capabilityChips(answers.area).filter(
                (chip) =>
                  chip.value === answers.what ||
                  usableCapability(answers.area, chip.value, emptyAreas)
              ),
              SHOW_ALL_CHIP,
            ]),
            selected: answers.what ? [answers.what] : [],
          });
        case "scope": {
          if (isErrorGroupOnly(answers.what)) {
            const loaded = errorGroups?.groups ?? [];
            const current = answers.scopeValue;
            const groups =
              current && !loaded.some((g) => encodeErrorGroupScope(g) === current)
                ? [
                    {
                      ...(parseErrorGroupScope(current) ?? { taskIdentifier: "", fingerprint: "" }),
                      label: errorGroupLabel(current),
                    },
                    ...loaded,
                  ]
                : loaded;
            const lookup = errorGroups?.lookup;
            return {
              ...base,
              id,
              question: promptForStep("scope", answers),
              options: [
                ...groups.map((group) => ({
                  id: encodeErrorGroupScope(group),
                  label: group.label,
                })),
                ...(lookup ? [{ id: ERROR_ID_OPTION, label: "Enter an error id…" }] : []),
              ],
              selected: answers.scopeValue ? [answers.scopeValue] : [],
              placeholder: errorGroups?.groups
                ? groups.length === 0
                  ? NO_ERROR_GROUPS
                  : "Select an error group"
                : "Loading…",
              selectDisabled: groups.length === 0 && !lookup,
              customOption: lookup ? ERROR_ID_OPTION : undefined,
              custom: lookup
                ? {
                    id: "errorId",
                    placeholder: ERROR_ID_PLACEHOLDER,
                    ariaLabel: "Error id",
                    parse: (text) => text.trim() || undefined,
                    onSubmit: lookup,
                  }
                : undefined,
              error: errorGroups?.lookupError,
            };
          }
          if (replacing) {
            return locked({
              ...base,
              id,
              question: promptForStep("scope", answers),
              options: toOptions(scopeChipsFor(answers.what)),
              selected: answers.scope ? [answers.scope] : [],
            });
          }
          const chips = scopeChipsFor(answers.what);
          const kind = scopeEntityKindFor(answers);
          const value = answers.scopeValue;
          const unknownScope =
            Boolean(answers.scope) && !chips.some((c) => c.value === answers.scope);
          const customValue =
            value && (unknownScope || (kind && scopeEntities && !scopeEntities.includes(value)))
              ? value
              : undefined;
          const customInput: ChatWizardInput | undefined = customValue
            ? {
                id: "scopeValue",
                current: customValue,
                ariaLabel: "Custom scope",
                parse: (text) => text.trim() || undefined,
                onSubmit: flow.setScopeValue,
              }
            : undefined;
          const customScope = unknownScope && customInput;
          return {
            ...base,
            id,
            question: promptForStep("scope", answers),
            options: customScope
              ? [...toOptions(chips), { id: CUSTOM_SCOPE, label: "Custom" }]
              : toOptions(chips),
            selected: customScope ? [CUSTOM_SCOPE] : answers.scope ? [answers.scope] : [],
            customOption: customScope ? CUSTOM_SCOPE : undefined,
            custom: customScope ? customInput : undefined,
            entityOption: kind,
            entity: kind
              ? {
                  id: kind,
                  ariaLabel: SCOPE_VALUE_LABEL[kind] ?? kind,
                  placeholder: scopeEntities
                    ? scopeEntities.length
                      ? `Select a ${kind}`
                      : `No ${kind}s found`
                    : "Loading…",
                  options: (scopeEntities ?? []).map((name) => ({
                    id: name,
                    label: kind === "queue" ? queueLabel(name) : name,
                  })),
                  selected: answers.scope === kind ? value : undefined,
                  onPick: () => {
                    if (answers.scope !== kind) flow.selectChip("scope", kind);
                  },
                  onSelect: flow.setScopeValue,
                  onSearch: kind === "queue" ? onScopeSearch : undefined,
                  custom: customInput,
                }
              : undefined,
          };
        }
        case "condition": {
          const kind = conditionKindFor(answers.what);
          const params = capabilityParams(answers.what);
          const numericKind = kind === "threshold" || kind === "absence";
          const single = !numericKind && params.length === 1 ? params[0] : undefined;
          const current = answers.conditionParams ?? {};
          const setParam = (key: string, value: number) =>
            flow.setConditionParams({ ...current, [key]: value });
          const clearParam = (key: string) => {
            const { [key]: _removed, ...rest } = current;
            flow.patchAnswers({ ...answers, conditionParams: rest });
          };
          const cap = resolveCapability(answers.what);
          const options = numericKind
            ? toOptions(conditionSuggestionChips(answers.what))
            : single
              ? paramSuggestionChips(single).map((chip) => ({
                  id: `${PARAM_OPTION}${chip.value}`,
                  label: chip.label,
                }))
              : [
                  {
                    id: CONTINUE_OPTION,
                    label: "Continue",
                    disabledReason: params.every((p) => current[p.key] !== undefined)
                      ? undefined
                      : FILL_THRESHOLDS,
                  },
                ];
          const singleValue = single ? current[single.key] : undefined;
          return {
            ...base,
            id,
            question: promptForStep("condition", answers),
            description:
              !numericKind && params.length > 1
                ? MULTI_PARAM_DESCRIPTION
                : stemSentence(answers.what),
            options,
            selected: numericKind
              ? answers.condition
                ? [answers.condition]
                : []
              : singleValue !== undefined
                ? [`${PARAM_OPTION}${singleValue}`]
                : params.length > 1 && params.every((p) => current[p.key] !== undefined)
                  ? [CONTINUE_OPTION]
                  : [],
            onReveal: () => {
              if (numericKind && answers.condition !== undefined) {
                flow.patchAnswers({ ...answers, condition: undefined });
              }
            },
            custom: numericKind
              ? {
                  id: "value",
                  current: options.some((option) => option.id === answers.condition)
                    ? undefined
                    : answers.condition,
                  placeholder: conditionStem(answers.what),
                  unit: kind === "absence" ? "min" : UNIT_LABEL[cap?.unit ?? "count"],
                  rule: {
                    min: kind === "absence" ? 30 : 0,
                    allowZero: kind !== "absence" && cap?.unit === "count",
                  },
                  ariaLabel:
                    kind === "absence"
                      ? "Quiet window in minutes"
                      : `${cap?.title ?? "Alert"} threshold`,
                  numeric: true,
                  parse: numberParse(kind === "absence" ? 30 : 0),
                  onSubmit: flow.setCondition,
                  onClear: () => flow.patchAnswers({ ...answers, condition: undefined }),
                }
              : single
                ? {
                    ...paramInput(
                      single,
                      singleValue,
                      (value) => {
                        setParam(single.key, value);
                        flow.confirmCondition();
                      },
                      false,
                      () => clearParam(single.key)
                    ),
                    placeholder: conditionStem(answers.what),
                  }
                : undefined,
            placeholder: conditionStem(answers.what),
            lead: !numericKind && params.length > 1 ? conditionStem(answers.what) : undefined,
            fields:
              !numericKind && params.length > 1
                ? params.map((param) =>
                    paramInput(
                      param,
                      current[param.key],
                      (value) => setParam(param.key, value),
                      true,
                      () => clearParam(param.key)
                    )
                  )
                : undefined,
          };
        }
        case "expiry": {
          const preset = EXPIRY_CHIPS.some((chip) => chip.value === answers.expiry);
          return {
            ...base,
            id,
            question: "How long should it stay active?",
            description: EXPIRY_DESCRIPTION,
            options: toOptions(EXPIRY_CHIPS),
            selected: answers.expiry ? [preset ? answers.expiry : CUSTOM_EXPIRY] : [],
            customOption: CUSTOM_EXPIRY,
            onReveal: () => {
              if (answers.expiry !== undefined)
                flow.patchAnswers({ ...answers, expiry: undefined });
            },
            custom: {
              id: "expiry",
              type: "date",
              current: preset ? undefined : expiryDate(answers.expiry)?.toISOString(),
              ariaLabel: "Expires at",
              parse: (text) => expiryFromDate(new Date(text)),
              onSubmit: flow.setExpiry,
              onClear: () => flow.patchAnswers({ ...answers, expiry: undefined }),
            },
          };
        }
        case "notifiers": {
          const options = [
            ...(chatId ? [{ id: CHAT_CHIP.value, label: CHAT_CHIP.label }] : []),
            ...channels
              .filter((ch, index) => channels.findIndex((c) => c.id === ch.id) === index)
              .map((ch) => ({ id: ch.id, label: ch.name || ch.type })),
          ];
          const selected = (answers.notifiers ?? []).filter((v) => options.some((o) => o.id === v));
          return {
            ...base,
            id,
            question: promptForStep("notifiers", answers),
            description: NOTIFIERS_DESCRIPTION,
            descriptionAction: { label: "channels list" },
            options: addChannel ? [...options, addChannelOption(addChannel)] : options,
            multiSelect: true,
            selected,
            confirmDisabled: !isComplete(answers) || answers.expiry === undefined,
            error: selected.length
              ? isComplete(answers) && answers.expiry !== undefined
                ? undefined
                : INCOMPLETE_DRAFT
              : NO_NOTIFIER,
          };
        }
      }
    });
}

export function applyStepSelection(
  flow: CreationFlowState,
  stepId: string,
  value: string,
  handlers: { onShowAll: () => void; onAddChannel: () => void }
) {
  if (stepId === "scenarios") {
    const [area, what] = value.split(":") as [FlowAnswers["area"], string];
    flow.patchAnswers({ area, what });
    return;
  }
  if (value === SHOW_ALL_CHIP.value) {
    handlers.onShowAll();
    return;
  }
  if (stepId === "scope" && parseErrorGroupScope(value)) {
    flow.selectChip("scope", "errorGroup");
    flow.setScopeValue(value);
    return;
  }
  switch (stepId as CardStepId) {
    case "area":
    case "what":
    case "scope":
      flow.selectChip(stepId as FlowStepKey, value);
      return;
    case "condition": {
      const param = capabilityParams(flow.answers.what)[0];
      if (value.startsWith(PARAM_OPTION) && param) {
        flow.setConditionParams({ [param.key]: Number(value.slice(PARAM_OPTION.length)) });
        flow.confirmCondition();
      } else if (value === CONTINUE_OPTION) {
        const params = capabilityParams(flow.answers.what);
        if (params.every((p) => flow.answers.conditionParams?.[p.key] !== undefined)) {
          flow.confirmCondition();
        }
      } else flow.setCondition(value);
      return;
    }
    case "environments":
      toggleEnvironment(flow, value);
      return;
    case "expiry":
      if (value !== CUSTOM_EXPIRY) flow.setExpiry(value);
      return;
    case "notifiers":
      if (value === ADD_CHANNEL_OPTION) handlers.onAddChannel();
      else flow.toggleNotifier(value);
      return;
  }
}
