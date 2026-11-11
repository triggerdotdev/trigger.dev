import { GROUP_CAPABILITY_KEY, type NotifierRef } from "@internal/alert-contracts";
import { $transaction, boundedIn, type PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import type { AlertLifecycleDeps } from "./alertLifecycle.server";
import {
  assertAlertDraftValid,
  uniqueNotifiers,
  type NewAlertInput,
} from "./createAlertFromDraft.server";
import { createAlert, deleteAlert, getAlert, type Alert } from "./storage/alertStore.server";

export type AlertGroupResult = { ok: true; alert: Alert } | { ok: false; error: string };

const GROUP_REJECTED = "AlertGroupRejected";

const rejectGroup = (error: string) => Object.assign(new Error(error), { name: GROUP_REJECTED });

type GroupRef = { groupId: string; projectId: string; environmentId: string };

async function lifecycleDeps(deps?: AlertLifecycleDeps): Promise<AlertLifecycleDeps> {
  if (deps) return deps;
  const worker = await import("~/v3/alertEngineWorker.server");
  return { enqueue: worker.enqueueAlertEvaluation, ack: worker.ackAlertEvaluation };
}

function groupMemberError(
  members: Array<Pick<Alert, "id" | "lifecycle" | "groupId" | "capabilityKey">>,
  ids: string[]
): string | null {
  if (ids.length < 2) return "A group needs at least 2 alerts";
  if (members.length !== ids.length) return "Every alert must be in this environment";
  if (members.some((m) => m.capabilityKey === GROUP_CAPABILITY_KEY)) {
    return "A group can't contain another group";
  }
  if (members.some((m) => m.groupId)) return "An alert is already in a group";
  if (members.some((m) => m.lifecycle !== "active")) return "Every alert must be active";
  return null;
}

export async function createAlertGroup(
  db: PrismaClientOrTransaction,
  params: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    memberAlertIds: string[];
    members?: NewAlertInput[];
    compositeMode: "any" | "all";
    name?: string;
    notifiers: NotifierRef[];
    expiresAt?: Date;
    createdBy: string;
  },
  deps?: AlertLifecycleDeps
): Promise<AlertGroupResult> {
  const existingIds = [...new Set(params.memberAlertIds)];
  const newMembers = params.members ?? [];
  if (existingIds.length + newMembers.length < 2) {
    return { ok: false, error: "A group needs at least 2 alerts" };
  }
  const groupCondition = {
    kind: "state" as const,
    stateKey: "group",
    compositeMode: params.compositeMode,
  };
  try {
    assertAlertDraftValid({
      capabilityKey: GROUP_CAPABILITY_KEY,
      condition: groupCondition,
      notifiers: params.notifiers,
      scope: { type: "all" },
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const created = await $transaction(db, async (tx) => {
    const memberIds: string[] = [];
    for (const member of newMembers) memberIds.push((await createAlert(tx, member)).id);
    const ids = [...existingIds, ...memberIds];
    const members = await tx.alert.findMany({
      where: {
        id: { in: boundedIn(ids) },
        projectId: params.projectId,
        environmentId: params.environmentId,
      },
      select: { id: true, lifecycle: true, groupId: true, capabilityKey: true },
    });
    const error = groupMemberError(members as Alert[], ids);
    if (error) throw rejectGroup(error);

    const alert = await createAlert(tx, {
      organizationId: params.organizationId,
      projectId: params.projectId,
      environmentId: params.environmentId,
      capabilityKey: GROUP_CAPABILITY_KEY,
      params: { environmentId: params.environmentId, scope: { type: "all" } },
      condition: { ...groupCondition, memberAlertIds: ids },
      expiresAt: params.expiresAt,
      notifiers: uniqueNotifiers(params.notifiers),
      name: params.name ?? `Group of ${ids.length} alerts`,
      createdBy: params.createdBy,
    });
    const claimed = await tx.alert.updateMany({
      where: { id: { in: boundedIn(ids) }, groupId: null, lifecycle: "active" },
      data: { groupId: alert.id, updatedAt: new Date() },
    });
    if (claimed.count !== ids.length) throw rejectGroup("An alert is already in a group");
    return { ok: true as const, alert, memberIds };
  }).catch((error) => {
    if (error instanceof Error && error.name === GROUP_REJECTED) {
      return { ok: false as const, error: error.message };
    }
    throw error;
  });
  if (!created || !created.ok) return created ?? { ok: false, error: "Group not created" };

  const lifecycle = await lifecycleDeps(deps);
  try {
    for (const id of [...created.memberIds, created.alert.id]) {
      await lifecycle.enqueue(id, new Date());
    }
  } catch (error) {
    logger.error("alerts.group.enqueue_failed", { alertId: created.alert.id, error });
    await ungroupAlert(db, {
      groupId: created.alert.id,
      projectId: params.projectId,
      environmentId: params.environmentId,
    });
    for (const id of created.memberIds) {
      await deleteAlert(db, {
        id,
        projectId: params.projectId,
        environmentId: params.environmentId,
      });
      await unschedule(id, lifecycle);
    }
    throw error;
  }
  return { ok: true, alert: created.alert };
}

export async function ungroupAlert(
  db: PrismaClientOrTransaction,
  params: GroupRef,
  deps?: AlertLifecycleDeps
): Promise<Alert | null> {
  const deleted = await deleteAlert(db, {
    id: params.groupId,
    projectId: params.projectId,
    environmentId: params.environmentId,
  });
  if (deleted) await unschedule(params.groupId, deps);
  return deleted;
}

async function unschedule(alertId: string, deps?: AlertLifecycleDeps) {
  await (await lifecycleDeps(deps)).ack(alertId).catch((error) => {
    logger.warn("alerts.group.ack_failed", { alertId, error });
  });
}

export async function removeGroupMember(
  db: PrismaClientOrTransaction,
  params: GroupRef & { alertId: string },
  deps?: AlertLifecycleDeps
): Promise<void> {
  const dissolved = await $transaction(db, async (tx) => {
    const [group] = await tx.$queryRaw<Array<{ condition: Record<string, unknown> }>>`
      SELECT "condition" FROM "Alert"
      WHERE "id" = ${params.groupId}
        AND "projectId" = ${params.projectId}
        AND "environmentId" = ${params.environmentId}
      FOR UPDATE`;
    if (!group) return false;
    await tx.alert.updateMany({
      where: { id: params.alertId, groupId: params.groupId },
      data: { groupId: null, updatedAt: new Date() },
    });
    const remaining = await tx.alert.findMany({
      where: { groupId: params.groupId },
      select: { id: true },
    });
    if (remaining.length < 2) {
      await deleteAlert(tx, { ...params, id: params.groupId });
      return true;
    }
    const ids = new Set(remaining.map((m) => m.id));
    const memberAlertIds = ((group.condition.memberAlertIds as string[] | undefined) ?? []).filter(
      (id) => ids.has(id)
    );
    await tx.alert.update({
      where: { id: params.groupId },
      data: { condition: { ...group.condition, memberAlertIds }, updatedAt: new Date() },
    });
    return false;
  });
  if (dissolved) await unschedule(params.groupId, deps);
}

export async function reclaimGroupMembers(
  db: PrismaClientOrTransaction,
  group: Pick<Alert, "id" | "environmentId">
): Promise<{ reclaimed: number; total: number }> {
  const [locked] = await db.$queryRaw<Array<{ condition: Record<string, unknown> }>>`
    SELECT "condition" FROM "Alert" WHERE "id" = ${group.id} FOR UPDATE`;
  const condition = locked?.condition ?? {};
  const memberAlertIds = (condition.memberAlertIds as string[] | undefined) ?? [];
  await db.alert.updateMany({
    where: {
      id: { in: boundedIn(memberAlertIds) },
      environmentId: group.environmentId,
      groupId: null,
      lifecycle: "active",
      capabilityKey: { not: GROUP_CAPABILITY_KEY },
    },
    data: { groupId: group.id, updatedAt: new Date() },
  });
  const owned = await db.alert.findMany({ where: { groupId: group.id }, select: { id: true } });
  const ownedIds = new Set(owned.map((m) => m.id));
  if (owned.length >= 2 && owned.length < memberAlertIds.length) {
    await db.alert.update({
      where: { id: group.id },
      data: {
        condition: {
          ...condition,
          memberAlertIds: memberAlertIds.filter((id) => ownedIds.has(id)),
        },
        updatedAt: new Date(),
      },
    });
  }
  return { reclaimed: owned.length, total: memberAlertIds.length };
}

export async function editAlertGroup(
  db: PrismaClientOrTransaction,
  params: GroupRef & { compositeMode?: "any" | "all"; name?: string }
): Promise<Alert | null> {
  const group = await getAlert(db, {
    id: params.groupId,
    projectId: params.projectId,
    environmentId: params.environmentId,
  });
  if (!group || group.capabilityKey !== GROUP_CAPABILITY_KEY) return null;
  await db.alert.update({
    where: { id: group.id },
    data: {
      ...(params.compositeMode
        ? { condition: { ...group.condition, compositeMode: params.compositeMode } }
        : {}),
      ...(params.name !== undefined ? { name: params.name } : {}),
      updatedAt: new Date(),
    },
  });
  return getAlert(db, { id: group.id });
}
