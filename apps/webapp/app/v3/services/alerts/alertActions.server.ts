import { displayStatus, type Condition, type NotifierRef } from "@internal/alert-contracts";
import type { PrismaClientOrTransaction } from "~/db.server";
import {
  getAlert,
  resolveAlert,
  updateAlertExpiry,
  updateAlertNotifiers,
} from "./storage/alertStore.server";
import {
  activateAlertAndSchedule,
  type AlertLifecycleDeps,
  deleteAlertAndUnschedule,
  stopAlertAndUnschedule,
} from "./alertLifecycle.server";
import { type AlertDraftScope } from "./alertDraft";
import { assertAlertDraftValid } from "./createAlertFromDraft.server";

export type AlertActionIntent = "resolve" | "stop" | "delete" | "activate";

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
  intent: "resolve" | "stop" | "delete";
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
    case "delete": {
      if (status.status !== "inactive") throw new AlertActionNotAllowedError("delete");
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

  const notifiers = params.notifiers ?? (alert.notifiers as NotifierRef[]);
  if (notifiers.length === 0) {
    throw new AlertActivationInvalidError("Add at least one notifier");
  }
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

  const result = await activateAlertAndSchedule(
    db,
    {
      id: params.alertId,
      projectId: params.projectId,
      environmentId: params.environmentId,
      now,
      expiresAt: params.expiresAt,
      notifiers: params.notifiers,
    },
    deps
  );
  if (!result) throw new AlertActionNotAllowedError("activate");
}

export async function editAlert(
  db: PrismaClientOrTransaction,
  params: {
    alertId: string;
    projectId: string;
    environmentId: string;
    notifiers?: NotifierRef[];
    expiresAt?: Date | null;
  }
): Promise<void> {
  const alert = await getAlert(db, {
    id: params.alertId,
    projectId: params.projectId,
    environmentId: params.environmentId,
  });
  if (!alert) throw new AlertNotFoundError();

  if (params.expiresAt !== undefined) {
    await updateAlertExpiry(db, {
      id: params.alertId,
      projectId: params.projectId,
      environmentId: params.environmentId,
      expiresAt: params.expiresAt,
    });
  }

  if (params.notifiers !== undefined) {
    await updateAlertNotifiers(db, {
      id: params.alertId,
      projectId: params.projectId,
      environmentId: params.environmentId,
      notifiers: params.notifiers,
    });
  }
}
