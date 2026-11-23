import {
  displayStatus,
  GROUP_CAPABILITY_KEY,
  notifierRefKey,
  type Condition,
  type NotifierRef,
} from "@internal/alert-contracts";
import { boundedIn } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import {
  canUseMonitoringAlerts,
  findMonitoringAlertsProject,
} from "~/services/monitoringAlertsApi.server";
import { logger } from "~/services/logger.server";
import { alertDisplayName } from "~/v3/services/alerts/alertDisplayName";
import {
  activateAlert,
  AlertActionNotAllowedError,
  AlertActivationInvalidError,
  AlertNotFoundError,
  editAlert,
  performAlertAction,
} from "~/v3/services/alerts/alertActions.server";
import {
  createAlertGroup,
  editAlertGroup,
  ungroupAlert,
} from "~/v3/services/alerts/alertGroups.server";
import {
  assertAlertDraftValid,
  uniqueNotifiers,
  type AlertDraftScope,
  type NewAlertInput,
} from "~/v3/services/alerts/createAlertFromDraft.server";
import { getAlert, type Alert } from "~/v3/services/alerts/storage/alertStore.server";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpPreviewRefusal, McpSubject } from "../gate/types";
import type { McpToolContext, McpToolResult } from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";
import {
  channelError,
  draftEffects,
  draftName,
  canReadQuery,
  loadChannels,
  memberDraft,
  previewWhere,
  QUERY_ACCESS,
  usesCustomQuery,
  type Where,
} from "./alertDrafts.server";
import { errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool, staleApproval } from "./defineWrite.server";
import {
  alertRef,
  expiryText,
  nothingChanged,
  notifierList,
  numbered,
  paramsText,
  quoted,
  quotedJson,
} from "./format/alertPreviews";
import { alertLabel } from "./format/alerts";
import { capText } from "./format/logFields";
import {
  ActivateAlertInput,
  AlertIdInput,
  CreateAlertGroupInput,
  UpdateAlertInput,
} from "./schemas/alertsManage";

const NOT_ENABLED = "Monitoring alerts are not enabled for this project";
const MAX_GROUP_SIZE = 20;
const serviceText = (message: string) => fenceUntrusted(capText(message, 500), "alert-error");
const NO_CHANNEL =
  "At least one channel is required; list_alert_channels shows the channels you can pass as notifiers";

type Plan<T> = ({ title: string; effects: string[] } & T) | { error: string };

async function runWhere(projectRef: string, ctx: McpToolContext): Promise<Where | McpToolResult> {
  const project = await findMonitoringAlertsProject(projectRef, ctx.identity.userId);
  if (!project) return errorResult("Project not found");
  if (!(await canUseMonitoringAlerts(project, ctx.identity.userId))) {
    return errorResult(NOT_ENABLED);
  }
  const environment = await resolveToolEnvironment(ctx);
  if (!environment) return errorResult("Not authorized");
  return {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    environmentType: environment.type,
  };
}

function previewOf<I, T>(plan: (input: I, where: Where) => Promise<Plan<T>>) {
  return async (input: I, subject: McpSubject | null): Promise<string | McpPreviewRefusal> => {
    const where = previewWhere(subject);
    if (!where) return { refuse: "Not authorized" };
    const result = await plan(input, where);
    return "error" in result
      ? { refuse: nothingChanged(result.error) }
      : numbered(result.title, result.effects);
  };
}

type AlertRow = { id: string; name: string | null; capabilityKey: string; params: unknown };

const named = (alert: AlertRow) => ({
  id: alert.id,
  name: alertDisplayName(alert),
});

const loadAlert = (id: string, where: Where) =>
  getAlert(prisma, { id, projectId: where.projectId, environmentId: where.environmentId });

const chatNotifiers = (stored: NotifierRef[]) => stored.filter((n) => n.type === "chat").length;

const chatRemovedText = (count: number) =>
  count > 0 ? ` ${count} chat notifier${count === 1 ? " was" : "s were"} removed.` : "";

function parseExpiry(value: string | undefined, now: Date): Date | null | undefined | string {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) {
    return "Pick an expiry in the future";
  }
  return date;
}

const groupMembers = (groupId: string, where: Where) =>
  prisma.alert.findMany({
    where: { groupId, projectId: where.projectId, environmentId: where.environmentId },
    select: { id: true, name: true, capabilityKey: true, params: true, lifecycle: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

const memberLines = (members: Array<AlertRow & { lifecycle: string }>) =>
  members.length > 0
    ? members.map((m) => `\n   - ${alertRef(named(m))}, lifecycle ${m.lifecycle}`).join("")
    : " (it has no members)";

const deletedWithHistory = (alert: { id: string; name: string }) => [
  `the alert ${alertRef(alert)} is deleted`,
  "all of its activity events and their notification delivery records are deleted",
  "it is removed from the evaluation schedule and sends no more notifications",
  "this is permanent and cannot be undone",
];

async function updatePlan(
  input: UpdateAlertInput,
  where: Where
): Promise<
  Plan<{
    alert: Alert;
    changed: string[];
    compositeMode?: "any" | "all";
    name?: string;
    expiresAt?: Date | null;
    notifiers?: NotifierRef[];
    chatRemoved: number;
  }>
> {
  const alert = await loadAlert(input.alertId, where);
  if (!alert) return { error: "Alert not found" };
  if (input.compositeMode && alert.capabilityKey !== GROUP_CAPABILITY_KEY) {
    return { error: "compositeMode only applies to alert groups" };
  }
  const expiresAt = parseExpiry(input.expiresAt, new Date());
  if (typeof expiresAt === "string") return { error: expiresAt };
  const requested = input.notifiers ? uniqueNotifiers(input.notifiers) : undefined;
  const invalid = requested && (await channelError(requested, where));
  if (invalid) return { error: invalid };

  const stored = alert.notifiers as NotifierRef[];
  const next = (requested ?? stored).filter((n) => n.type !== "chat");
  const writeNotifiers = requested !== undefined || next.length !== stored.length;
  if (writeNotifiers && next.length === 0) return { error: NO_CHANNEL };

  const effects: string[] = [];
  const changed: string[] = [];
  const oldMode = (alert.condition as { compositeMode?: string }).compositeMode ?? "any";
  const compositeMode =
    input.compositeMode && input.compositeMode !== oldMode ? input.compositeMode : undefined;
  if (compositeMode) {
    effects.push(`composite mode: ${oldMode} → ${compositeMode}`);
    changed.push("composite mode");
  }
  const name = input.name !== undefined && input.name !== alert.name ? input.name : undefined;
  if (name !== undefined) {
    effects.push(`name: ${alert.name === null ? "(none)" : quoted(alert.name)} → ${quoted(name)}`);
    changed.push("name");
  }
  const newExpiry =
    expiresAt !== undefined && expiresAt?.getTime() !== alert.expiresAt?.getTime()
      ? expiresAt
      : undefined;
  if (newExpiry !== undefined) {
    effects.push(`expiry: ${expiryText(alert.expiresAt)} → ${expiryText(newExpiry)}`);
    changed.push("expiry");
  }
  const sameNotifiers =
    next.length === stored.length &&
    next.every((n, i) => notifierRefKey(n) === notifierRefKey(stored[i]!));
  if (writeNotifiers && !sameNotifiers) {
    changed.push("notifiers");
    const channels = await loadChannels(where.projectId, [...stored, ...next]);
    const note = requested ? "" : " (chat notifiers are removed)";
    effects.push(
      `notifiers: ${notifierList(stored, channels)} → ${notifierList(next, channels)}${note}`
    );
  }
  if (effects.length === 0) {
    return { error: `Alert ${alertLabel(named(alert))} already has these settings` };
  }
  return {
    title: `Update alert ${alertRef(named(alert))}:`,
    effects,
    alert,
    changed,
    compositeMode,
    name,
    expiresAt: newExpiry,
    notifiers: requested && !sameNotifiers ? next : undefined,
    chatRemoved: chatNotifiers(stored),
  };
}

async function stopPlan(input: AlertIdInput, where: Where): Promise<Plan<{ alert: Alert }>> {
  const alert = await loadAlert(input.alertId, where);
  if (!alert) return { error: "Alert not found" };
  const status = displayStatus(alert.lifecycle, alert.attention).status;
  if (status !== "active") {
    const ref = alertLabel(named(alert));
    return {
      error:
        status !== "needs_attention"
          ? `Alert ${ref} is already ${alert.lifecycle}, so there is nothing to stop`
          : alert.lifecycle === "active"
            ? `Alert ${ref} needs attention; resolve it with resolve_alert first, then stop it`
            : `Alert ${ref} needs attention and is already ${alert.lifecycle}; resolve it with resolve_alert; there is nothing to stop`,
    };
  }
  const effects = [
    "lifecycle: active → stopped, recorded as stopped by you",
    'a "stopped" event is added to its activity',
    "it is removed from the evaluation schedule and sends no more notifications",
  ];
  if (alert.capabilityKey === GROUP_CAPABILITY_KEY) {
    effects.push(
      `every member leaves the group and keeps running on its own:${memberLines(await groupMembers(alert.id, where))}`
    );
  }
  if (alert.groupId) {
    const group = await loadAlert(alert.groupId, where);
    const groupRef = group ? alertRef(named(group)) : `id ${quoted(alert.groupId)}`;
    effects.push(
      `it stays in the group ${groupRef}, but the group ignores it while it is stopped (a stopped member counts as unavailable in the any/all result)`
    );
  }
  return { title: `Stop alert ${alertRef(named(alert))}:`, effects, alert };
}

async function activatePlan(
  input: ActivateAlertInput,
  where: Where
): Promise<
  Plan<{ alert: Alert; expiresAt?: Date | null; notifiers?: NotifierRef[]; chatRemoved: number }>
> {
  const alert = await loadAlert(input.alertId, where);
  if (!alert) return { error: "Alert not found" };
  const status = displayStatus(alert.lifecycle, alert.attention).status;
  if (status !== "inactive") {
    const ref = alertLabel(named(alert));
    return {
      error:
        status !== "needs_attention"
          ? `Alert ${ref} is already active`
          : alert.lifecycle === "active"
            ? `Alert ${ref} needs attention and is still running; resolve it with resolve_alert; there is nothing to activate`
            : `Alert ${ref} needs attention; resolve it with resolve_alert first, then activate it${alert.lifecycle === "expired" ? " with a new expiresAt" : ""}`,
    };
  }
  const now = new Date();
  const expiresAt = parseExpiry(input.expiresAt, now);
  if (typeof expiresAt === "string") return { error: expiresAt };
  const effective = expiresAt === undefined ? alert.expiresAt : expiresAt;
  if (effective && effective.getTime() <= now.getTime()) {
    return { error: 'The alert\'s expiry has passed. Pass a new expiresAt, or "none"' };
  }
  const requested = input.notifiers ? uniqueNotifiers(input.notifiers) : undefined;
  const stored = alert.notifiers as NotifierRef[];
  const next = (requested ?? stored).filter((n) => n.type !== "chat");
  const invalid = await channelError(next, where);
  if (invalid) return { error: invalid };
  if (next.length === 0) return { error: NO_CHANNEL };
  try {
    const scope = (alert.params as { scope?: { type?: AlertDraftScope["type"] } }).scope;
    assertAlertDraftValid({
      capabilityKey: alert.capabilityKey,
      scope: { type: scope?.type ?? "all" },
      condition: alert.condition as Condition,
      notifiers: next,
    });
  } catch (error) {
    return {
      error: serviceText(error instanceof Error ? error.message : String(error)),
    };
  }

  const effects = [
    `lifecycle: ${alert.lifecycle} → active; attention is cleared and evaluation restarts from now`,
  ];
  effects.push(
    expiresAt !== undefined
      ? `expiry: ${expiryText(alert.expiresAt)} → ${expiryText(expiresAt)}`
      : `expiry: ${expiryText(alert.expiresAt)} (unchanged)`
  );
  const channels = await loadChannels(where.projectId, [...stored, ...next]);
  if (requested || next.length !== stored.length) {
    const note = requested ? "" : " (chat notifiers are removed)";
    effects.push(
      `notifiers: ${notifierList(stored, channels)} → ${notifierList(next, channels)}${note}`
    );
  } else {
    effects.push(`notifiers: ${notifierList(next, channels)} (unchanged)`);
  }
  effects.push(
    alert.capabilityKey === GROUP_CAPABILITY_KEY
      ? `it keeps composite mode ${(alert.condition as { compositeMode?: string }).compositeMode ?? "any"}`
      : `it keeps capability ${quoted(alert.capabilityKey)}, params ${paramsText(alert.params)}, condition ${quotedJson(alert.condition)}${alert.query ? `, query ${quoted(alert.query)}` : ""}`
  );
  if (alert.capabilityKey === GROUP_CAPABILITY_KEY) {
    const ids = (alert.condition as { memberAlertIds?: string[] }).memberAlertIds ?? [];
    const rows = await prisma.alert.findMany({
      where: { id: { in: boundedIn(ids) }, environmentId: where.environmentId },
      select: {
        id: true,
        name: true,
        capabilityKey: true,
        params: true,
        lifecycle: true,
        groupId: true,
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const lines = ids.map((id) => {
      const row = byId.get(id);
      if (!row) return { ok: false, text: `id ${quoted(id)}: not found, dropped from the group` };
      const ref = alertRef(named(row));
      if (row.capabilityKey === GROUP_CAPABILITY_KEY || row.lifecycle !== "active" || row.groupId) {
        return {
          ok: false,
          text: `${ref}: not active or already in a group, dropped from the group`,
        };
      }
      return { ok: true, text: `${ref}: rejoins the group` };
    });
    const rejoining = lines.filter((line) => line.ok).length;
    if (rejoining < 2) {
      return {
        error: `Only ${rejoining} of ${ids.length} alerts can be regrouped; ungroup and create the group again`,
      };
    }
    effects.push(`group members:${lines.map((line) => `\n   - ${line.text}`).join("")}`);
  }
  effects.push("it is scheduled for evaluation now");
  return {
    title: `Activate alert ${alertRef(named(alert))}:`,
    effects,
    alert,
    expiresAt,
    notifiers: requested ? next : undefined,
    chatRemoved: chatNotifiers(stored),
  };
}

async function deletePlan(
  input: AlertIdInput,
  where: Where
): Promise<Plan<{ alert: Alert; dissolvedGroupId?: string }>> {
  const alert = await loadAlert(input.alertId, where);
  if (!alert) return { error: "Alert not found" };
  const status = displayStatus(alert.lifecycle, alert.attention).status;
  if (status !== "inactive") {
    const ref = alertLabel(named(alert));
    return {
      error:
        status !== "needs_attention"
          ? `Alert ${ref} is active; stop it with stop_alert first, then delete it`
          : alert.lifecycle === "active"
            ? `Alert ${ref} needs attention; resolve it with resolve_alert, stop it with stop_alert, then delete it`
            : `Alert ${ref} needs attention; resolve it with resolve_alert, then delete it`,
    };
  }
  const self = named(alert);
  const title = `Delete alert ${alertRef(self)}:`;
  if (alert.capabilityKey === GROUP_CAPABILITY_KEY) {
    return { title, effects: ungroupEffects(self, await groupMembers(alert.id, where)), alert };
  }

  const effects: string[] = [];
  let dissolvedGroupId: string | undefined;
  if (alert.groupId) {
    const group = await loadAlert(alert.groupId, where);
    const others = (await groupMembers(alert.groupId, where)).filter((m) => m.id !== alert.id);
    const groupRef = group ? alertRef(named(group)) : `id ${quoted(alert.groupId)}`;
    if (others.length < 2) {
      dissolvedGroupId = alert.groupId;
      effects.push(
        `it leaves the group ${groupRef}; the group then has fewer than 2 members, so the group is deleted too, with all of its activity events and notification delivery records, and is removed from the evaluation schedule`
      );
      for (const other of others) {
        effects.push(
          `the remaining member ${alertRef(named(other))} leaves the group and keeps running on its own`
        );
      }
    } else {
      effects.push(
        `it leaves the group ${groupRef}, which keeps its other ${others.length} members`
      );
    }
  }
  effects.push(...deletedWithHistory(self));
  return { title, effects, alert, dissolvedGroupId };
}

function ungroupEffects(
  group: { id: string; name: string },
  members: Awaited<ReturnType<typeof groupMembers>>
) {
  return [
    ...deletedWithHistory(group),
    `every member leaves the group and keeps its own state and schedule:${memberLines(members)}`,
  ];
}

async function ungroupPlan(input: AlertIdInput, where: Where): Promise<Plan<{ alert: Alert }>> {
  const alert = await loadAlert(input.alertId, where);
  if (!alert) return { error: "Alert not found" };
  if (alert.capabilityKey !== GROUP_CAPABILITY_KEY) return { error: "This alert is not a group" };
  const self = named(alert);
  return {
    title: `Ungroup alert ${alertRef(self)}:`,
    effects: ungroupEffects(self, await groupMembers(alert.id, where)),
    alert,
  };
}

async function createGroupPlan(
  input: CreateAlertGroupInput,
  where: Where,
  createdBy: string
): Promise<
  Plan<{
    memberAlertIds: string[];
    members: NewAlertInput[];
    expiresAt?: Date;
    notifiers: NotifierRef[];
  }>
> {
  const existingIds = [...new Set(input.memberAlertIds ?? [])];
  const drafts = input.members ?? [];
  if (!input.memberAlertIds === !input.members) {
    return { error: "Pass either memberAlertIds or members" };
  }
  if (existingIds.length + drafts.length < 2) return { error: "A group needs at least 2 alerts" };
  if (existingIds.length + drafts.length > MAX_GROUP_SIZE) {
    return { error: `A group can have at most ${MAX_GROUP_SIZE} alerts` };
  }
  const expiresAt = parseExpiry(input.expiresAt, new Date());
  if (typeof expiresAt === "string") return { error: expiresAt };
  const notifiers = uniqueNotifiers(input.notifiers);
  const allNotifiers = [...notifiers, ...drafts.flatMap((d) => d.notifiers)];
  const invalid = await channelError(allNotifiers, where);
  if (invalid) return { error: invalid };

  const existing = await prisma.alert.findMany({
    where: {
      id: { in: boundedIn(existingIds) },
      projectId: where.projectId,
      environmentId: where.environmentId,
    },
    select: {
      id: true,
      name: true,
      capabilityKey: true,
      params: true,
      lifecycle: true,
      attention: true,
      groupId: true,
    },
  });
  const byId = new Map(existing.map((row) => [row.id, row]));
  if (existing.length !== existingIds.length) return { error: "Alert not found" };
  if (existing.some((m) => m.capabilityKey === GROUP_CAPABILITY_KEY)) {
    return { error: "A group can't contain another group" };
  }
  const grouped = existing.find((m) => m.groupId);
  if (grouped) {
    return {
      error: `Alert ${alertLabel(named(grouped))} is already in the group id ${quoted(grouped.groupId!)}; dissolve that group with ungroup_alert first`,
    };
  }
  const inactive = existing.find((m) => m.lifecycle !== "active");
  if (inactive) {
    const expiry = inactive.lifecycle === "expired" ? " (pass a new expiresAt)" : "";
    const step =
      inactive.attention === "needs_attention"
        ? `resolve it with resolve_alert, then activate it with activate_alert${expiry}`
        : `activate it with activate_alert${expiry}`;
    return {
      error: `Alert ${alertLabel(named(inactive))} is ${inactive.lifecycle} and only active alerts can be grouped; ${step}`,
    };
  }

  const members: NewAlertInput[] = [];
  for (const [index, draft] of drafts.entries()) {
    const built = memberDraft({ ...draft, behavior: draft.behavior ?? {} }, index, {
      ...where,
      createdBy,
    });
    if ("error" in built) return built;
    members.push(built);
  }

  const channels = await loadChannels(where.projectId, allNotifiers);
  const effects: string[] = [];
  const newLines = members.map(
    (m) => `\n   - ${draftName(m)}: ${draftEffects(m, channels).join(", ")}`
  );
  if (members.length > 0) effects.push(`these new alerts are created:${newLines.join("")}`);
  effects.push(
    `the group alert ${quoted(input.name)} is created: composite mode ${input.compositeMode}, notifiers ${notifierList(notifiers, channels)}, expiry ${expiryText(expiresAt)}`
  );
  const joining = [
    ...existingIds.map((id) => `\n   - ${alertRef(named(byId.get(id)!))}`),
    ...members.map((m) => `\n   - ${draftName(m)} (new)`),
  ];
  effects.push(`these alerts join the group:${joining.join("")}`);
  effects.push(
    "while the group is active its members keep evaluating on their own schedule but no longer notify on their own; only the group's notifiers are used"
  );
  effects.push(
    members.length > 0
      ? "the group and each new alert are scheduled for evaluation"
      : "the group is scheduled for evaluation"
  );
  return {
    title: `Create alert group ${quoted(input.name)}:`,
    effects,
    memberAlertIds: existingIds,
    members,
    expiresAt: expiresAt ?? undefined,
    notifiers,
  };
}

function serviceError(error: unknown, alreadyDone?: string): McpToolResult {
  const known =
    error instanceof AlertNotFoundError
      ? "Alert not found"
      : error instanceof AlertActionNotAllowedError || error instanceof AlertActivationInvalidError
        ? serviceText(error.message)
        : undefined;
  if (known === undefined) throw error;
  return errorResult(
    alreadyDone
      ? `${known}. ${alreadyDone}; check the alert with get_alert_details.`
      : nothingChanged(known)
  );
}

function logErased(
  ctx: McpToolContext,
  where: Where,
  tool: string,
  alert: { id: string; groupId: string | null },
  dissolvedGroupId?: string
) {
  logger.info("mcp.alert.erased", {
    tool,
    alertId: alert.id,
    groupId: alert.groupId ?? undefined,
    dissolvedGroupId,
    userId: ctx.identity.userId,
    environmentId: where.environmentId,
    confirmationId: ctx.confirmation?.id,
  });
}

const alertIdAction =
  (
    intent: "stop" | "delete",
    plan: (
      input: AlertIdInput,
      where: Where
    ) => Promise<Plan<{ alert: Alert; dissolvedGroupId?: string }>>,
    done: string
  ) =>
  async (input: AlertIdInput, ctx: McpToolContext): Promise<McpToolResult> => {
    const where = await runWhere(input.projectRef!, ctx);
    if ("content" in where) return where;
    const planned = await plan(input, where);
    if ("error" in planned) return errorResult(nothingChanged(planned.error));
    const stale = staleApproval(ctx, numbered(planned.title, planned.effects));
    if (stale) return stale;
    try {
      await performAlertAction(prisma, {
        intent,
        alertId: planned.alert.id,
        projectId: where.projectId,
        environmentId: where.environmentId,
        actorId: ctx.identity.userId,
      });
    } catch (error) {
      return serviceError(
        error,
        intent === "delete" && planned.alert.groupId
          ? "The alert may already have been removed from its group"
          : undefined
      );
    }
    if (intent === "delete") {
      logErased(ctx, where, "delete_alert", planned.alert, planned.dissolvedGroupId);
    }
    return textResult(`Alert ${alertLabel(named(planned.alert))} ${done}.`);
  };

const auth = { action: "write", subject: "alerts" } as const;

export const alertsManageTools: McpToolDefinition[] = [
  defineWriteTool({
    name: "update_alert",
    title: "Update Monitoring Alert",
    description:
      "Change a monitoring alert's name, notifiers, expiry or, for an alert group, its composite mode. Only the fields you pass change.",
    shape: UpdateAlertInput.shape,
    approval: "configurable",
    auth,
    confirm: { preview: previewOf(updatePlan) },
    run: async (input, ctx) => {
      const where = await runWhere(input.projectRef!, ctx);
      if ("content" in where) return where;
      const planned = await updatePlan(input, where);
      if ("error" in planned) return errorResult(nothingChanged(planned.error));
      const stale = staleApproval(ctx, numbered(planned.title, planned.effects));
      if (stale) return stale;
      const ref = { projectId: where.projectId, environmentId: where.environmentId };
      let modeWritten = false;
      try {
        if (planned.compositeMode) {
          const edited = await editAlertGroup(prisma, {
            ...ref,
            groupId: planned.alert.id,
            compositeMode: planned.compositeMode,
          });
          modeWritten = edited !== null;
        }
        await editAlert(prisma, {
          ...ref,
          alertId: planned.alert.id,
          notifiers: planned.notifiers,
          expiresAt: planned.expiresAt,
          name: planned.name,
        });
      } catch (error) {
        return serviceError(
          error,
          modeWritten
            ? "The composite mode was already changed, but the other changes were not applied"
            : undefined
        );
      }
      const stored = await loadAlert(planned.alert.id, where);
      if (!stored) {
        return errorResult(
          "The alert was not found after the update, so the changes cannot be confirmed; it may have been deleted. Check with list_alerts."
        );
      }
      const keys = (list: NotifierRef[]) => list.map(notifierRefKey).join(",");
      const expectedNotifiers =
        planned.notifiers ??
        (planned.chatRemoved > 0
          ? (planned.alert.notifiers as NotifierRef[]).filter((n) => n.type !== "chat")
          : undefined);
      const missing = [
        planned.name !== undefined && stored.name !== planned.name ? "name" : "",
        planned.expiresAt !== undefined &&
        stored.expiresAt?.getTime() !== planned.expiresAt?.getTime()
          ? "expiry"
          : "",
        expectedNotifiers !== undefined &&
        keys(stored.notifiers as NotifierRef[]) !== keys(expectedNotifiers)
          ? "notifiers"
          : "",
        planned.compositeMode !== undefined &&
        (stored.condition as { compositeMode?: string }).compositeMode !== planned.compositeMode
          ? "composite mode"
          : "",
      ].filter(Boolean);
      if (missing.length > 0) {
        return errorResult(
          `The update was only partly applied; these are not in place: ${missing.join(", ")}. Check the alert with get_alert_details.`
        );
      }
      const after = named({ ...planned.alert, name: planned.name ?? planned.alert.name });
      const renamed =
        planned.name === undefined ? "" : ` Previously ${alertLabel(named(planned.alert))}.`;
      return textResult(
        `Alert ${alertLabel(after)} updated: ${planned.changed.join(", ")}.${renamed}${chatRemovedText(planned.chatRemoved)}`
      );
    },
  }),
  defineWriteTool({
    name: "stop_alert",
    title: "Stop Monitoring Alert",
    description:
      "Stop an active monitoring alert so it no longer evaluates or notifies. Stopping a group releases its members.",
    shape: AlertIdInput.shape,
    approval: "configurable",
    auth,
    confirm: { preview: previewOf(stopPlan) },
    run: alertIdAction("stop", stopPlan, "stopped"),
  }),
  defineWriteTool({
    name: "activate_alert",
    title: "Activate Monitoring Alert",
    description:
      "Activate a stopped, completed or expired monitoring alert, optionally with a new expiry or notifiers.",
    shape: ActivateAlertInput.shape,
    approval: "configurable",
    auth,
    confirm: { preview: previewOf(activatePlan) },
    run: async (input, ctx) => {
      const where = await runWhere(input.projectRef!, ctx);
      if ("content" in where) return where;
      const planned = await activatePlan(input, where);
      if ("error" in planned) return errorResult(nothingChanged(planned.error));
      const stale = staleApproval(ctx, numbered(planned.title, planned.effects));
      if (stale) return stale;
      try {
        await activateAlert(prisma, {
          alertId: planned.alert.id,
          projectId: where.projectId,
          environmentId: where.environmentId,
          actorId: ctx.identity.userId,
          expiresAt: planned.expiresAt,
          notifiers: planned.notifiers,
        });
      } catch (error) {
        return serviceError(error);
      }
      return textResult(
        `Alert ${alertLabel(named(planned.alert))} activated.${chatRemovedText(planned.chatRemoved)}`
      );
    },
  }),
  defineWriteTool({
    name: "delete_alert",
    title: "Delete Monitoring Alert",
    description:
      "Delete a stopped, completed or expired monitoring alert with its activity history. Deleting a group releases its members. The user approves the deletion in the dashboard before it runs.",
    shape: AlertIdInput.shape,
    approval: "required",
    auth,
    confirm: { preview: previewOf(deletePlan) },
    run: alertIdAction("delete", deletePlan, "deleted"),
  }),
  defineWriteTool({
    name: "create_alert_group",
    title: "Create Monitoring Alert Group",
    description:
      "Combine 2 to 20 alerts into one group alert that notifies on their combined state: either existing active alerts (memberAlertIds) or new alerts defined like create_alert (members).",
    shape: CreateAlertGroupInput.shape,
    approval: "configurable",
    auth,
    confirm: {
      precheck: (input, ability, subject) =>
        usesCustomQuery((input.members ?? []).map((m) => m.capabilityKey)) &&
        !canReadQuery(ability, subject?.environmentType)
          ? QUERY_ACCESS
          : undefined,
      preview: async (input, subject) => {
        const where = previewWhere(subject);
        if (!where) return { refuse: "Not authorized" };
        const planned = await createGroupPlan(input, where, "");
        return "error" in planned
          ? { refuse: nothingChanged(planned.error) }
          : numbered(planned.title, planned.effects);
      },
    },
    run: async (input, ctx) => {
      const where = await runWhere(input.projectRef!, ctx);
      if ("content" in where) return where;
      if (
        usesCustomQuery((input.members ?? []).map((m) => m.capabilityKey)) &&
        !canReadQuery(ctx.ability, where.environmentType)
      ) {
        return errorResult("Not authorized");
      }
      const planned = await createGroupPlan(input, where, ctx.identity.userId);
      if ("error" in planned) return errorResult(nothingChanged(planned.error));
      const stale = staleApproval(ctx, numbered(planned.title, planned.effects));
      if (stale) return stale;
      const result = await createAlertGroup(prisma, {
        organizationId: where.organizationId,
        projectId: where.projectId,
        environmentId: where.environmentId,
        memberAlertIds: planned.memberAlertIds,
        members: planned.members,
        compositeMode: input.compositeMode,
        name: input.name,
        notifiers: planned.notifiers,
        expiresAt: planned.expiresAt,
        createdBy: ctx.identity.userId,
      });
      if (!result.ok) return errorResult(nothingChanged(serviceText(result.error)));
      return textResult(`Alert group created: ${alertLabel(named(result.alert))}`);
    },
  }),
  defineWriteTool({
    name: "ungroup_alert",
    title: "Ungroup Monitoring Alert",
    description:
      "Dissolve an alert group: the group alert and its history are deleted and every member keeps running on its own. The user approves this in the dashboard before it runs.",
    shape: AlertIdInput.shape,
    approval: "required",
    auth,
    confirm: { preview: previewOf(ungroupPlan) },
    run: async (input, ctx) => {
      const where = await runWhere(input.projectRef!, ctx);
      if ("content" in where) return where;
      const planned = await ungroupPlan(input, where);
      if ("error" in planned) return errorResult(nothingChanged(planned.error));
      const stale = staleApproval(ctx, numbered(planned.title, planned.effects));
      if (stale) return stale;
      const deleted = await ungroupAlert(prisma, {
        groupId: planned.alert.id,
        projectId: where.projectId,
        environmentId: where.environmentId,
      });
      if (!deleted) return errorResult("Alert not found");
      logErased(ctx, where, "ungroup_alert", planned.alert);
      return textResult(
        `Alert group ${alertLabel(named(deleted))} deleted; its members now run on their own.`
      );
    },
  }),
];
