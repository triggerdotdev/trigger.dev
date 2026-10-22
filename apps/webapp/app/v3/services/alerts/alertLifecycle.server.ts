import type { PrismaClientOrTransaction } from "~/db.server";
import {
  activateAlert,
  createAlert,
  deleteAlert,
  deleteAlertIfNoEvents,
  stopAlert,
  type Alert,
} from "./storage/alertStore.server";
import { logger } from "~/services/logger.server";

export type AlertLifecycleDeps = {
  enqueue: (alertId: string, availableAt: Date) => Promise<unknown>;
  ack: (alertId: string) => Promise<unknown>;
};

async function defaultDeps(): Promise<AlertLifecycleDeps> {
  const worker = await import("~/v3/alertEngineWorker.server");
  return { enqueue: worker.enqueueAlertEvaluation, ack: worker.ackAlertEvaluation };
}

async function schedule(alertId: string, deps: AlertLifecycleDeps) {
  try {
    await deps.enqueue(alertId, new Date());
  } catch (error) {
    logger.error("alerts.lifecycle.enqueue_failed", { alertId, error });
    throw error;
  }
}

async function unschedule(alertId: string, deps: AlertLifecycleDeps) {
  try {
    await deps.ack(alertId);
  } catch (error) {
    logger.warn("alerts.lifecycle.ack_failed", { alertId, error });
  }
}

export async function createAlertAndSchedule(
  db: PrismaClientOrTransaction,
  input: Parameters<typeof createAlert>[1],
  deps?: AlertLifecycleDeps
): Promise<Alert> {
  const alert = await createAlert(db, input);
  try {
    await schedule(alert.id, deps ?? (await defaultDeps()));
  } catch (error) {
    let kept = false;
    try {
      kept = !(await deleteAlertIfNoEvents(db, {
        id: alert.id,
        projectId: alert.projectId,
        environmentId: alert.environmentId,
      }));
    } catch (deleteError) {
      logger.error("alerts.lifecycle.rollback_failed", { alertId: alert.id, error: deleteError });
    }
    if (!kept) throw error;
    logger.warn("alerts.lifecycle.rollback_skipped", { alertId: alert.id });
  }
  return alert;
}

export async function stopAlertAndUnschedule(
  db: PrismaClientOrTransaction,
  params: Parameters<typeof stopAlert>[1],
  deps?: AlertLifecycleDeps
) {
  const result = await stopAlert(db, params);
  if (result) await unschedule(params.id, deps ?? (await defaultDeps()));
  return result;
}

export async function deleteAlertAndUnschedule(
  db: PrismaClientOrTransaction,
  params: Parameters<typeof deleteAlert>[1],
  deps?: AlertLifecycleDeps
) {
  const result = await deleteAlert(db, params);
  if (result) await unschedule(params.id, deps ?? (await defaultDeps()));
  return result;
}

export async function activateAlertAndSchedule(
  db: PrismaClientOrTransaction,
  params: Parameters<typeof activateAlert>[1],
  deps?: AlertLifecycleDeps
) {
  const result = await activateAlert(db, params);
  if (result) await schedule(params.id, deps ?? (await defaultDeps()));
  return result;
}
