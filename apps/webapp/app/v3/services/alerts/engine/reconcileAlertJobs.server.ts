import type { PrismaClientOrTransaction } from "~/db.server";
import { listActiveAlertsForReconcile } from "../storage/alertStore.server";

export const RECONCILE_CRON = "0 * * * *";
export const BOOT_RECONCILE_JOB_ID = "alerts.reconcile:boot";

const RECONCILE_CURSOR_KEY = "reconcile:cursor";

const PAGE_SIZE = 200;
const DEFAULT_DEADLINE_MS = 240_000;

interface ReconcileCursorStore {
  get(): Promise<string | null>;
  set(cursor: string | null): Promise<void>;
}

export function redisReconcileCursorStore(redis: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}): ReconcileCursorStore {
  return {
    get: () => redis.get(RECONCILE_CURSOR_KEY),
    set: async (cursor) => {
      if (cursor) await redis.set(RECONCILE_CURSOR_KEY, cursor);
      else await redis.del(RECONCILE_CURSOR_KEY);
    },
  };
}

export interface ReconcileAlertJobsDeps {
  db: PrismaClientOrTransaction;
  enqueueOnce: (alertId: string, availableAt: Date) => Promise<boolean>;
  cursorStore?: ReconcileCursorStore;
  pageSize?: number;
  deadlineMs?: number;
  logger?: { warn: (message: string, ...args: any[]) => void };
}

export async function reconcileAlertJobs(
  params: { now: Date },
  deps: ReconcileAlertJobsDeps
): Promise<{ scanned: number; enqueued: number; complete: boolean }> {
  const deadline = Date.now() + (deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
  let scanned = 0;
  let enqueued = 0;
  let cursor = (await deps.cursorStore?.get()) ?? undefined;

  while (Date.now() < deadline) {
    const result = await listActiveAlertsForReconcile(deps.db, {
      cursor,
      limit: deps.pageSize ?? PAGE_SIZE,
    });
    for (const alert of result.alerts) {
      scanned++;
      if (await deps.enqueueOnce(alert.id, alert.nextEvaluationAt ?? params.now)) enqueued++;
    }
    if (!result.nextCursor) {
      await deps.cursorStore?.set(null);
      return { scanned, enqueued, complete: true };
    }
    cursor = result.nextCursor;
  }

  await deps.cursorStore?.set(cursor ?? null);
  deps.logger?.warn("alerts.reconcile.deadline_reached", { scanned, enqueued, cursor });
  return { scanned, enqueued, complete: false };
}

type BootReconcileEnqueuer = {
  enqueueOnce(options: {
    id: string;
    job: "alerts.reconcile";
    payload: { cron: string; timestamp: number };
    availableAt: Date;
  }): Promise<boolean>;
};

export function enqueueBootReconcile(worker: BootReconcileEnqueuer, now: Date) {
  return worker.enqueueOnce({
    id: BOOT_RECONCILE_JOB_ID,
    job: "alerts.reconcile",
    payload: { cron: RECONCILE_CRON, timestamp: now.getTime() },
    availableAt: now,
  });
}
