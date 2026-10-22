import type { PrismaClient } from "~/db.server";
import {
  ensureAlertHistoryPartitions,
  type DeferredPartition,
} from "../storage/alertPartitions.server";

const SEEN_SWEEP_BATCH = 10_000;
const RUN_BUDGET_MS = 4 * 60_000;

export interface AlertPartitionDdlClient {
  get(): PrismaClient;
  discard(): Promise<void>;
}

export interface AlertPartitionMaintenanceDeps {
  prisma: PrismaClient;
  ddlClient: AlertPartitionDdlClient;
  logger: {
    info: (message: string, ...args: any[]) => void;
    error: (message: string, ...args: any[]) => void;
  };
  ensurePartitions?: typeof ensureAlertHistoryPartitions;
  clock?: () => number;
}

export interface AlertPartitionMaintenanceResult {
  created: string[];
  dropped: string[];
  deferred: DeferredPartition[];
  sweptSeen: number;
}

export async function runAlertPartitionMaintenance(
  params: { now: Date },
  deps: AlertPartitionMaintenanceDeps
): Promise<AlertPartitionMaintenanceResult> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const ensurePartitions = deps.ensurePartitions ?? ensureAlertHistoryPartitions;
  const partitions = await ensurePartitions(deps.ddlClient.get(), {
    now: params.now,
    deadline: started + RUN_BUDGET_MS,
  });
  if (partitions.warning) {
    deps.logger.error("alerts.partitions.lookahead_low", {
      lookaheadMonths: partitions.lookaheadMonths,
      warning: partitions.warning,
    });
  }
  if (partitions.connectionStuck) {
    deps.logger.error("alerts.partitions.connection_stuck", {});
    await deps.ddlClient.discard();
  }
  if (partitions.deferred.length > 0) {
    deps.logger.error("alerts.partitions.deferred", { deferred: partitions.deferred });
  }

  let sweptSeen = 0;
  if (clock() - started >= RUN_BUDGET_MS) {
    deps.logger.error("alerts.partitions.sweep_skipped", { elapsedMs: clock() - started });
  }
  while (clock() - started < RUN_BUDGET_MS) {
    const deleted = await deps.prisma.$executeRaw`
      DELETE FROM "AlertOccurrenceSeen" WHERE ctid IN (
        SELECT ctid FROM "AlertOccurrenceSeen"
        WHERE "expiresAt" < ${params.now.toISOString()}::timestamptz
        LIMIT ${SEEN_SWEEP_BATCH}
      )`;
    sweptSeen += deleted;
    if (deleted < SEEN_SWEEP_BATCH) break;
  }

  const result = {
    created: partitions.created,
    dropped: partitions.dropped,
    deferred: partitions.deferred,
    sweptSeen,
  };
  deps.logger.info("alerts.partitions.maintenance", result);
  return result;
}
