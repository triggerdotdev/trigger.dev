import {
  getCapability,
  GROUP_CAPABILITY_KEY,
  validateConditionParams,
  type NotifierRef,
} from "@internal/alert-contracts";
import { boundedIn, type RuntimeEnvironmentType } from "@trigger.dev/database";
import type { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { defaultCapabilityLookup } from "~/services/monitoringAlertsApi.server";
import {
  buildAlertFromDraft,
  InvalidQueryAlertError,
  QUERY_DOMAIN_ERRORS,
  type AlertDraftScope,
  type NewAlertInput,
} from "~/v3/services/alerts/createAlertFromDraft.server";
import {
  MonitoringAlertsCreateBodySchema,
  MonitoringAlertsMemberBodySchema,
  type MonitoringAlertsMemberBody,
} from "~/v3/services/alerts/monitoringAlertsSchemas";
import { stateFields, validateAlertDraft } from "~/v3/services/alerts/validateAlertDraft.server";
import { findValidNotifierChannelIds } from "~/v3/services/alerts/validateNotifierChannels.server";
import { fenceUntrusted } from "../gate/fence.server";
import type { RbacAbility } from "@trigger.dev/rbac";
import type { McpSubject } from "../gate/types";
import {
  destinationRef,
  expiryText,
  nothingChanged,
  notifierList,
  paramsText,
  quoted,
  quotedJson,
  type PreviewChannel,
} from "./format/alertPreviews";
import { capText } from "./format/logFields";

const MAX_ERROR = 500;

export type Where = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  environmentType: RuntimeEnvironmentType;
};

export function previewWhere(subject: McpSubject | null): Where | null {
  const { organizationId, projectId, environmentId, environmentType } = subject ?? {};
  if (!organizationId || !projectId || !environmentId || !environmentType) return null;
  return { organizationId, projectId, environmentId, environmentType };
}

const fencedText = (message: string) => fenceUntrusted(capText(message, MAX_ERROR), "alert-error");

export async function loadChannels(projectId: string, notifiers: NotifierRef[]) {
  const ids = notifiers.flatMap((n) => (n.type === "channel" ? [n.channelId] : []));
  const rows =
    ids.length > 0
      ? await prisma.projectAlertChannel.findMany({
          where: { id: { in: boundedIn(ids) }, projectId },
          select: {
            id: true,
            name: true,
            type: true,
            properties: true,
            enabled: true,
            environmentTypes: true,
            alertTypes: true,
            integrationId: true,
          },
        })
      : [];
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        type: row.type,
        properties: row.properties,
        ref: destinationRef(row, env.SESSION_SECRET),
      },
    ])
  );
}

const FRIENDLY_CHANNEL_ID = /^alert_channel_/;

export function friendlyChannelIdError(notifiers: NotifierRef[]): string | null {
  return notifiers.some((n) => n.type === "channel" && FRIENDLY_CHANNEL_ID.test(n.channelId))
    ? nothingChanged(
        "A notifier channelId has the shape of a channel friendlyId; pass the channelId from list_alert_channels instead"
      )
    : null;
}

export async function channelError(notifiers: NotifierRef[], where: Where): Promise<string | null> {
  const friendly = friendlyChannelIdError(notifiers);
  if (friendly) return friendly;
  const ids = notifiers.flatMap((n) => (n.type === "channel" ? [n.channelId] : []));
  if (ids.length === 0) return null;
  const valid = await findValidNotifierChannelIds(
    prisma,
    where.projectId,
    ids,
    where.environmentType
  );
  return valid.length === new Set(ids).size
    ? null
    : nothingChanged(
        "One or more notifier channels are not available in this environment; list_alert_channels shows the channels you can pass as notifiers"
      );
}

function alertDraftError(draft: MonitoringAlertsMemberBody): string | null {
  const capability = defaultCapabilityLookup(draft.capabilityKey);
  const error = validateAlertDraft({
    capability,
    capabilityKey: draft.capabilityKey,
    surface: "mcp",
    conditionKind: draft.condition.kind,
    quietWindowSec: draft.condition.kind === "absence" ? draft.condition.quietWindowSec : undefined,
    scope: draft.params.scope,
    ...stateFields(draft.condition),
  });
  if (error) return error.message;
  if (capability && "params" in draft.condition && draft.condition.params) {
    try {
      validateConditionParams(draft.condition.params, capability.binding.params ?? []);
    } catch (e) {
      return (e as Error).message;
    }
  }
  return null;
}

type DraftContext = Where & { createdBy: string };

function alertDraftInput(
  draft: MonitoringAlertsMemberBody,
  context: DraftContext
): NewAlertInput | { error: string } {
  const error = alertDraftError(draft);
  if (error) return { error: nothingChanged(fencedText(error)) };
  const shared = {
    organizationId: context.organizationId,
    projectId: context.projectId,
    environmentId: context.environmentId,
    createdBy: context.createdBy,
    capabilityKey: draft.capabilityKey,
    condition: draft.condition,
    expiresAt: draft.behavior.expiresAt ? new Date(draft.behavior.expiresAt) : undefined,
    notifiers: draft.notifiers,
    name: draft.name,
  };
  if (draft.capabilityKey !== "custom.query") {
    return {
      ...shared,
      params: {
        environmentId: context.environmentId,
        scope: draft.params.scope,
        windowSec: draft.params.windowSec,
      },
    };
  }
  try {
    return buildAlertFromDraft({
      ...shared,
      scope: draft.params.scope as AlertDraftScope,
      query: draft.query,
      querySignalChoice: draft.signal,
    });
  } catch (error) {
    if (
      error instanceof InvalidQueryAlertError ||
      QUERY_DOMAIN_ERRORS.some((cls) => error instanceof cls)
    ) {
      return { error: nothingChanged(fencedText((error as Error).message)) };
    }
    throw error;
  }
}

const issueText = (error: z.ZodError) => {
  const issue = error.issues[0];
  return fencedText(`${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`);
};

export function createAlertDraft(
  input: unknown,
  context: DraftContext
): NewAlertInput | { error: string } {
  const body = MonitoringAlertsCreateBodySchema.safeParse(input);
  if (!body.success) {
    return { error: nothingChanged(`Invalid request body: ${issueText(body.error)}`) };
  }
  const { condition, capabilityKey } = body.data;
  if (capabilityKey === GROUP_CAPABILITY_KEY || "memberAlertIds" in condition) {
    return { error: nothingChanged("This capability cannot be created from this tool") };
  }
  return alertDraftInput({ ...body.data, condition } as MonitoringAlertsMemberBody, context);
}

export function memberDraft(
  member: unknown,
  index: number,
  context: DraftContext
): NewAlertInput | { error: string } {
  const parsed = MonitoringAlertsMemberBodySchema.safeParse(member);
  if (!parsed.success) {
    return { error: nothingChanged(`Invalid member ${index + 1}: ${issueText(parsed.error)}`) };
  }
  const draft = parsed.data;
  if (
    draft.capabilityKey === GROUP_CAPABILITY_KEY ||
    (draft.condition.kind === "state" && draft.condition.memberAlertIds)
  ) {
    return { error: nothingChanged("A group can't contain another group") };
  }
  return alertDraftInput(draft, context);
}

export const draftName = (alert: NewAlertInput) =>
  quoted(alert.name ?? getCapability(alert.capabilityKey)?.title ?? alert.capabilityKey);

export function draftEffects(alert: NewAlertInput, channels: Map<string, PreviewChannel>) {
  return [
    `capability ${quoted(alert.capabilityKey)}`,
    `params ${paramsText(alert.params)}`,
    `condition ${quotedJson(alert.condition)}`,
    ...(alert.query ? [`query ${quoted(alert.query)}`] : []),
    `notifiers ${notifierList((alert.notifiers ?? []) as NotifierRef[], channels)}`,
    `expiry ${expiryText(alert.expiresAt)}`,
  ];
}

export const QUERY_ACCESS = { action: "read", subject: "query" } as const;

export const canReadQuery = (
  ability: RbacAbility | undefined,
  environmentType: RuntimeEnvironmentType | undefined
) =>
  !!ability?.can("read", {
    type: "query",
    ...(environmentType ? { envType: environmentType } : {}),
  });

export const usesCustomQuery = (capabilityKeys: Array<string | undefined>) =>
  capabilityKeys.includes("custom.query");
