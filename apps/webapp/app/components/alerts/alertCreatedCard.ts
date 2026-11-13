import type { LimitSignal } from "@internal/alert-contracts";
import type {
  AlertCreatedBlock,
  AlertCreatedRow,
  EnvelopedAlertCreatedBlock,
} from "@internal/dashboard-agent-contracts";
import {
  ALERT_CREATION_OPENING_MESSAGE_ID_PREFIX,
  VIEW_BLOCK_VERSION,
} from "@internal/dashboard-agent-contracts";
import {
  notifyLabel,
  type AlertChannel,
} from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  alertName,
  conditionSummary,
  expiryLabel,
  isComplete,
  isExpiryTimestamp,
  labelFor,
  resolveCapability,
  type FlowAnswers,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import { formatNumber } from "~/utils/numberFormatter";
import { limitScopeLabel } from "./limitSummary";
import { QUERY_CONDITION_LABELS, QUERY_SCOPE_LABEL } from "./queryAlertLink";

export const ALERT_CREATION_OPENING_TEXT = "Create a new alert";
export const REVIEW_MESSAGE =
  "That's everything I need. The alert below is what I'll create — create it when you're happy, or keep changing it in words.";
const PLAN_CREATED_MESSAGE = "Created.";
const PLAN_ITEM_KEY_SEPARATOR = "\n";
export const EXPIRY_TOKEN_PATTERN = /^(none|deploy|incident|\d+h)$/;

export function joinPlanItemKeys(keys: (string | undefined)[]): string | undefined {
  const present = keys.filter((key): key is string => Boolean(key));
  return present.length ? present.join(PLAN_ITEM_KEY_SEPARATOR) : undefined;
}

export function splitPlanItemKeys(key: string): string[] {
  return key.split(PLAN_ITEM_KEY_SEPARATOR);
}

export type CreatedCardFields = {
  name: string;
  conditionSummary: string;
  scopeLabel: string;
  scopeValue?: string;
  environmentTitle?: string;
  behavior: "recurring";
  notifyLabel: string;
  expiryLabel?: string;
  expiresAt?: string;
};

export function scopeLabelFor(answers: FlowAnswers): string {
  return (
    (answers.what ? limitScopeLabel(answers.what, answers.components) : undefined) ??
    labelFor("scope", answers.scope, answers)
  );
}

export function fullConditionSummary(answers: FlowAnswers): string {
  const base = conditionSummary(answers);
  if (!base) return "";
  return answers.windowMinutes ? `${base} for ${formatNumber(answers.windowMinutes)}m` : base;
}

export function createdCardFields(
  answers: FlowAnswers,
  channels: AlertChannel[],
  name?: string,
  environmentTitle?: string
): CreatedCardFields | null {
  if (!isComplete(answers)) return null;
  return {
    name: name ?? alertName(answers),
    conditionSummary: fullConditionSummary(answers),
    scopeLabel: scopeLabelFor(answers),
    scopeValue: answers.scope === "errorGroup" ? undefined : answers.scopeValue,
    environmentTitle,
    behavior: "recurring",
    notifyLabel: notifyLabel(answers, channels),
    ...(isExpiryTimestamp(answers.expiry)
      ? { expiresAt: new Date(answers.expiry!).toISOString() }
      : { expiryLabel: expiryLabel(answers.expiry) }),
  };
}

function lifetimeRow(
  fields: Pick<CreatedCardFields, "expiresAt" | "expiryLabel">
): AlertCreatedRow {
  return fields.expiresAt
    ? { label: "Lifetime", value: `It expires ${fields.expiresAt}.`, expiresAt: fields.expiresAt }
    : {
        label: "Lifetime",
        value: fields.expiryLabel
          ? `It ${fields.expiryLabel}.`
          : "It stays active until you turn it off.",
      };
}

function createdCardRows(fields: CreatedCardFields): AlertCreatedRow[] {
  const scopeVal = fields.scopeValue ? ` · ${fields.scopeValue}` : "";
  const env = fields.environmentTitle ? ` · ${fields.environmentTitle}` : "";
  return [
    lifetimeRow(fields),
    {
      label: "Watching",
      value: `${fields.conditionSummary}${env} · ${fields.scopeLabel}${scopeVal}`,
    },
    { label: "Notifying", value: `Notifying: ${fields.notifyLabel}.` },
    { label: "Placement", value: "It's at the top of your alerts list." },
  ];
}

function createdBlock(
  alertId: string,
  name: string,
  rows: AlertCreatedRow[],
  planItemKey?: string
): EnvelopedAlertCreatedBlock {
  return {
    type: "alert_created",
    id: `alert:${alertId}`,
    revision: 0,
    version: VIEW_BLOCK_VERSION,
    alertId,
    name,
    rows,
    ...(planItemKey ? { planItemKey } : {}),
  };
}

export function alertCreatedBlock(
  alertId: string,
  fields: CreatedCardFields,
  planItemKey?: string
): EnvelopedAlertCreatedBlock {
  return createdBlock(alertId, fields.name, createdCardRows(fields), planItemKey);
}

const GROUP_MEMBERS_SHOWN = 5;
const GROUP_CREATED_MESSAGE = "I created the group. Here is what it watches.";

export type GroupCreatedFields = {
  name: string;
  compositeMode: "any" | "all";
  memberNames: string[];
  channelNames: string[];
  expiresAt?: string;
};

export function groupCreatedBlock(
  alertId: string,
  fields: GroupCreatedFields,
  planItemKey?: string
): EnvelopedAlertCreatedBlock {
  const shown = fields.memberNames.slice(0, GROUP_MEMBERS_SHOWN);
  const more = fields.memberNames.length - shown.length;
  return createdBlock(
    alertId,
    fields.name,
    [
      lifetimeRow(fields),
      {
        label: "Watching",
        value: `Raises when: ${fields.compositeMode} of ${fields.memberNames.length} alerts (${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}).`,
      },
      { label: "Notifying", value: `Notifying: ${fields.channelNames.join(", ") || "None"}.` },
    ],
    planItemKey
  );
}

export type AlertCreatedMessage = {
  id: string;
  role: "assistant";
  parts: [
    { type: "text"; text: string },
    { type: "data-view"; data: { blocks: [EnvelopedAlertCreatedBlock] } },
  ];
};

function createdMessage(
  alertId: string,
  block: EnvelopedAlertCreatedBlock,
  text = REVIEW_MESSAGE
): AlertCreatedMessage {
  return {
    id: `alert_created:${alertId}`,
    role: "assistant",
    parts: [
      { type: "text", text },
      { type: "data-view", data: { blocks: [block] } },
    ],
  };
}

export function alertCreatedMessage(
  alertId: string,
  fields: CreatedCardFields,
  planItemKey?: string
): AlertCreatedMessage {
  return createdMessage(
    alertId,
    alertCreatedBlock(alertId, fields, planItemKey),
    planItemKey ? PLAN_CREATED_MESSAGE : REVIEW_MESSAGE
  );
}

export function groupCreatedMessage(
  alertId: string,
  fields: GroupCreatedFields,
  planItemKey?: string
): AlertCreatedMessage {
  return createdMessage(
    alertId,
    groupCreatedBlock(alertId, fields, planItemKey),
    GROUP_CREATED_MESSAGE
  );
}

export function alertCreationOpeningMessage(chatId: string) {
  return {
    id: `${ALERT_CREATION_OPENING_MESSAGE_ID_PREFIX}${chatId}`,
    role: "user" as const,
    parts: [{ type: "text" as const, text: ALERT_CREATION_OPENING_TEXT }],
  };
}

type CreateAlertRequestCard = {
  expiry?: string;
  form: {
    capabilityKey: string;
    scopeType: string;
    scopeValue?: string;
    conditionKind: string;
    operator?: string;
    value?: number;
    windowMinutes?: number;
    quietWindowMinutes?: number;
    conditionParams?: Record<string, number>;
    compositeMode?: "any" | "all";
    signals?: LimitSignal[];
    components?: string[];
    expiresAt?: string;
    notifierChannelIds: string[];
  };
};

function queryConditionSummary({ form }: CreateAlertRequestCard): string {
  switch (form.conditionKind) {
    case "threshold":
      return `${QUERY_CONDITION_LABELS.threshold}: ${form.operator ?? ">"} ${form.value} over ${form.windowMinutes}m`;
    case "absence":
      return `${QUERY_CONDITION_LABELS.absence} (${form.quietWindowMinutes}m)`;
    default:
      return QUERY_CONDITION_LABELS.match;
  }
}

export function requestCardFields(
  body: CreateAlertRequestCard,
  channels: AlertChannel[],
  name?: string,
  environmentTitle?: string
): CreatedCardFields | null {
  const answers = answersFromCreateRequest(body);
  if (body.form.capabilityKey !== "custom.query") {
    return createdCardFields(answers, channels, name, environmentTitle);
  }
  return {
    name: name ?? QUERY_SCOPE_LABEL,
    conditionSummary: queryConditionSummary(body),
    scopeLabel: QUERY_SCOPE_LABEL,
    environmentTitle,
    behavior: "recurring",
    notifyLabel: notifyLabel(answers, channels),
    ...(isExpiryTimestamp(answers.expiry)
      ? { expiresAt: new Date(answers.expiry!).toISOString() }
      : { expiryLabel: expiryLabel(answers.expiry) }),
  };
}

export function answersFromCreateRequest(body: CreateAlertRequestCard): FlowAnswers {
  const { form } = body;
  const condition =
    form.conditionKind === "threshold"
      ? form.value
      : form.conditionKind === "absence"
        ? form.quietWindowMinutes
        : undefined;
  return {
    area: resolveCapability(form.capabilityKey)?.area,
    what: form.capabilityKey,
    scope: form.scopeType,
    scopeValue: form.scopeValue,
    condition: condition === undefined ? undefined : String(condition),
    conditionParams: form.conditionParams,
    compositeMode: form.compositeMode,
    signals: form.signals,
    components: form.components,
    windowMinutes: form.conditionKind === "threshold" ? form.windowMinutes : undefined,
    notifiers: form.notifierChannelIds,
    expiry: body.expiry ?? form.expiresAt,
  };
}

export function shownCreatedBlock(
  flow: { createdBlock?: AlertCreatedBlock; createdAlertId?: string },
  fields: CreatedCardFields | null
): AlertCreatedBlock | null {
  if (flow.createdBlock) return flow.createdBlock;
  return fields ? alertCreatedBlock(flow.createdAlertId ?? "", fields) : null;
}
