import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { Prisma, PrismaClient } from "@trigger.dev/database";

/**
 * Copies a run's TaskRunExecutionSnapshot rows from the primary database into the
 * replica database. The replica (a schema-only clone) has no parent rows (no TaskRun),
 * so the rows are inserted with FK triggers disabled - exactly how a physical replica's
 * data arrives, without FK re-checks.
 */
export async function copySnapshotsToReplica(
  primary: PrismaClient,
  replica: PrismaClient,
  runId: string,
  opts?: { excludeSnapshotIds?: string[] }
) {
  const rows = await primary.taskRunExecutionSnapshot.findMany({ where: { runId } });
  const toCopy = rows.filter((r) => !(opts?.excludeSnapshotIds ?? []).includes(r.id));

  await replica.$transaction(async (tx) => {
    // SET LOCAL applies for the duration of this transaction (same connection),
    // disabling FK triggers like a physical replica's apply process.
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);

    for (const row of toCopy) {
      await tx.taskRunExecutionSnapshot.create({
        data: {
          id: row.id,
          engine: row.engine,
          executionStatus: row.executionStatus,
          description: row.description,
          isValid: row.isValid,
          error: row.error,
          previousSnapshotId: row.previousSnapshotId,
          runId: row.runId,
          runStatus: row.runStatus,
          batchId: row.batchId,
          attemptNumber: row.attemptNumber,
          environmentId: row.environmentId,
          environmentType: row.environmentType,
          projectId: row.projectId,
          organizationId: row.organizationId,
          completedWaitpointOrder: row.completedWaitpointOrder,
          checkpointId: row.checkpointId,
          workerId: row.workerId,
          runnerId: row.runnerId,
          // Preserve timestamps exactly - the snapshots-since window query depends on them.
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          lastHeartbeatAt: row.lastHeartbeatAt,
          metadata: row.metadata === null ? Prisma.DbNull : row.metadata,
        },
      });
    }
  });
}

/**
 * Creates a real OTel meter backed by an in-memory exporter, plus a helper to read
 * a counter's current cumulative value. No mocks - this exercises the same metrics
 * pipeline production uses.
 */
export function createTestMetricsMeter() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  // Long interval: exports only happen via explicit forceFlush() below.
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const meterProvider = new MeterProvider({ readers: [reader] });
  const meter = meterProvider.getMeter("test");

  const getCounterValue = async (name: string): Promise<number> => {
    await reader.forceFlush();
    const resourceMetrics = exporter.getMetrics();

    // Cumulative temporality: every export batch carries the full running total,
    // so read the most recent batch that contains the metric. A counter that was
    // never added to exports no data points - treat that as 0.
    for (let i = resourceMetrics.length - 1; i >= 0; i--) {
      for (const scopeMetrics of resourceMetrics[i].scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (metric.descriptor.name === name && metric.dataPoints.length > 0) {
            return metric.dataPoints.reduce((sum, dp) => sum + (dp.value as number), 0);
          }
        }
      }
    }

    return 0;
  };

  return { meter, getCounterValue };
}
