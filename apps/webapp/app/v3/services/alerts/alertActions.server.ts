import {
  displayStatus,
  GROUP_CAPABILITY_KEY,
  type Condition,
  type NotifierRef,
} from "@internal/alert-contracts";
import { $transaction, type PrismaClientOrTransaction } from "~/db.server";
import {
  activateAlert as activateStoredAlert,
  getAlert,
  resolveAlert,
  updateAlertExpiry,
  updateAlertNotifiers,
} from "./storage/alertStore.server";
import {
  activateAlertAndSchedule,
  type AlertLifecycleDeps,
  deleteAlertAndUnschedule,
  scheduleAlert,
  stopAlertAndUnschedule,
} from "./alertLifecycle.server";
import { type AlertDraftScope } from "./alertDraft";
import { assertAlertDraftValid, NoNotifiersError } from "./createAlertFromDraft.server";
import { reclaimGroupMembers, removeGroupMember, ungroupAlert } from "./alertGroups.server";

export type AlertActionIntent = "resolve" | "stop" | "delete" | "activate" | "ungroup";

export class AlertNotFoundError extends Error {
  constructor() {
    super("Alert not found");
  }
}

export class AlertActionNotAllowedError extends Error {
  constructor(public readonly intent: AlertActionIntent | string) {
    super(`Cannot ${intent} this alert in its current state`);
  }
}

export type PerformAlertActionParams = {
  intent: "resolve" | "stop" | "delete" | "ungroup";
  alertId: string;
  projectId: string;
  environmentId: string;
  actorId: string;
};

export async function performAlertAction(
  db: PrismaClientOrTransaction,
  params: PerformAlertActionParams,
  deps?: AlertLifecycleDeps
): Promise<void> {
  const alert = await getAlert(db, {
    id: params.alertId,
    projectId: params.projectId,
    environmentId: params.environmentId,
  });
  if (!alert) throw new AlertNotFoundError();

  const status = displayStatus(alert.lifecycle, alert.attention);
  const ref = { projectId: params.projectId, environmentId: params.environmentId };

  switch (params.intent) {
    case "resolve": {
      if (status.status !== "needs_attention") throw new AlertActionNotAllowedError("resolve");
      const result = await resolveAlert(db, { id: alert.id, actorId: params.actorId });
      if (!result) throw new AlertActionNotAllowedError("resolve");
      return;
    }
    case "stop": {
      if (status.status !== "active") throw new AlertActionNotAllowedError("stop");
      const result = await stopAlertAndUnschedule(
        db,
        {
          id: alert.id,
          actorId: params.actorId,
          projectId: params.projectId,
          environmentId: params.environmentId,
        },
        deps
      );
      if (!result) throw new AlertActionNotAllowedError("stop");
      return;
    }
    case "ungroup": {
      if (alert.capabilityKey !== GROUP_CAPABILITY_KEY) {
        throw new AlertActionNotAllowedError("ungroup");
      }
      await ungroupAlert(db, { ...ref, groupId: alert.id }, deps);
      return;
    }
    case "delete": {
      if (status.status !== "inactive") throw new AlertActionNotAllowedError("delete");
      if (alert.capabilityKey === GROUP_CAPABILITY_KEY) {
        await ungroupAlert(db, { ...ref, groupId: alert.id }, deps);
        return;
      }
      if (alert.groupId) {
        await removeGroupMember(db, { ...ref, groupId: alert.groupId, alertId: alert.id }, deps);
      }
      const deleted = await deleteAlertAndUnschedule(
        db,
        {
          id: alert.id,
          projectId: params.projectId,
          environmentId: params.environmentId,
        },
        deps
      );
      if (!deleted) throw new AlertActionNotAllowedError("delete");
      return;
    }
  }
}

export class AlertActivationInvalidError extends Error {}

/**
 * Activates an inactive alert after the same checks as create. `expiresAt` undefined keeps the
 * stored expiry, null clears it; `notifiers` undefined keeps the stored ones.
 */
export async function activateAlert(
  db: PrismaClientOrTransaction,
  params: {
    alertId: string;
    projectId: string;
    environmentId: string;
    actorId: string;
    expiresAt?: Date | null;
    notifiers?: NotifierRef[];
    now?: Date;
  },
  deps?: AlertLifecycleDeps
): Promise<void> {
  const alert = await getAlert(db, {
    id: params.alertId,
    projectId: params.projectId,
    environmentId: params.environmentId,
  });
  if (!alert) throw new AlertNotFoundError();

  const status = displayStatus(alert.lifecycle, alert.attention);
  if (status.status !== "inactive") {
    throw new AlertActionNotAllowedError("activate");
  }

  const now = params.now ?? new Date();
  const expiresAt = params.expiresAt === undefined ? alert.expiresAt : params.expiresAt;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    throw new AlertActivationInvalidError("Pick an expiry in the future");
  }

  const notifiers = (params.notifiers ?? (alert.notifiers as NotifierRef[])).filter(
    (notifier) => notifier.type !== "chat"
  );
  const scope = (alert.params as { scope?: { type?: AlertDraftScope["type"] } }).scope;
  try {
    assertAlertDraftValid({
      capabilityKey: alert.capabilityKey,
      scope: { type: scope?.type ?? "all" },
      condition: alert.condition as Condition,
      notifiers,
    });
  } catch (error) {
    throw new AlertActivationInvalidError(error instanceof Error ? error.message : String(error));
  }

  const activation = {
    id: params.alertId,
    projectId: params.projectId,
    environmentId: params.environmentId,
    now,
    expiresAt: params.expiresAt,
    notifiers: params.notifiers ?? notifiers,
  };
  if (alert.capabilityKey !== GROUP_CAPABILITY_KEY) {
    const result = await activateAlertAndSchedule(db, activation, deps);
    if (!result) throw new AlertActionNotAllowedError("activate");
    return;
  }

  await $transaction(db, async (tx) => {
    const { reclaimed, total } = await reclaimGroupMembers(tx, alert);
    if (reclaimed < 2) {
      throw new AlertActivationInvalidError(
        `Only ${reclaimed} of ${total} alerts can be regrouped; ungroup and create the group again`
      );
    }
    if (!(await activateStoredAlert(tx, activation))) {
      throw new AlertActionNotAllowedError("activate");
    }
  });
  await scheduleAlert(params.alertId, deps);
}

export async function editAlert(
  db: PrismaClientOrTransaction,
  params: {
    alertId: string;
    projectId: string;
    environmentId: string;
    notifiers?: NotifierRef[];
    expiresAt?: Date | null;
    name?: string;
  }
): Promise<void> {
  const alert = await getAlert(db, {
    id: params.alertId,
    projectId: params.projectId,
    environmentId: params.environmentId,
  });
  if (!alert) throw new AlertNotFoundError();

  const stored = alert.notifiers as NotifierRef[];
  const notifiers = (params.notifiers ?? stored).filter((notifier) => notifier.type !== "chat");
  const writeNotifiers = params.notifiers !== undefined || notifiers.length !== stored.length;
  if (writeNotifiers && notifiers.length === 0) {
    throw new AlertActivationInvalidError(new NoNotifiersError().message);
  }

  if (params.name !== undefined && params.name !== alert.name) {
    await db.alert.update({
      where: { id: alert.id },
      data: { name: params.name, updatedAt: new Date() },
    });
  }

  if (params.expiresAt !== undefined) {
    await updateAlertExpiry(db, {
      id: params.alertId,
      projectId: params.projectId,
      environmentId: params.environmentId,
      expiresAt: params.expiresAt,
    });
  }

  if (writeNotifiers) {
    await updateAlertNotifiers(db, {
      id: params.alertId,
      projectId: params.projectId,
      environmentId: params.environmentId,
      notifiers,
    });
  }
}
