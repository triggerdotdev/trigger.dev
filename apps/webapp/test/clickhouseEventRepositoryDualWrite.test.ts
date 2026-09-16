import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import {
  ClickhouseEventRepository,
  logsSearchRolloutSelectedRowCount,
} from "~/v3/eventRepository/clickhouseEventRepository.server";
import { latestMetrics, metricSum } from "./otlpMetrics.helpers";
import { createInMemoryMetrics } from "./utils/tracing";

function event(overrides: Partial<TaskEventV2Input> = {}): TaskEventV2Input {
  const now = BigInt(Date.now()) * 1_000_000n;
  const seconds = now / 1_000_000_000n;
  const nanoseconds = (now % 1_000_000_000n).toString().padStart(9, "0");

  return {
    environment_id: "env_dual_write_test",
    organization_id: "org_dual_write_test",
    project_id: "project_dual_write_test",
    task_identifier: "dual-write-task",
    run_id: "run_dual_write_test",
    start_time: `${seconds}.${nanoseconds}`,
    duration: "1000000",
    trace_id: "trace_dual_write_test",
    span_id: "span_dual_write_test",
    parent_span_id: "",
    message: "source write survives",
    kind: "LOG_INFO",
    status: "OK",
    attributes: { value: "searchable" },
    metadata: "{}",
    expires_at: new Date(Date.now() + 86_400_000).toISOString().replace("T", " ").replace("Z", ""),
    ...overrides,
  };
}

async function shutdownRepository(repository: ClickhouseEventRepository): Promise<void> {
  await Promise.all([
    (repository as any)._flushScheduler.shutdown(),
    (repository as any)._llmMetricsFlushScheduler.shutdown(),
    (repository as any)._otlpMetricsFlushScheduler.shutdown(),
  ]);
}

describe("logs search rollout selection", () => {
  it("does not select rows outside the by-id rollout", () => {
    expect(
      logsSearchRolloutSelectedRowCount("by-id", new Set(["org_enabled"]), [
        { organization_id: "org_disabled_1" },
        { organization_id: "org_disabled_2" },
      ])
    ).toBe(0);
  });
});

describe("ClickhouseEventRepository logs search dual writer", () => {
  clickhouseTest(
    "writes eligible rows for configured organizations",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        logLevel: "error",
      });
      const metrics = createInMemoryMetrics();
      const repository = new ClickhouseEventRepository({
        clickhouse,
        meter: metrics.meter,
        version: "v2",
        insertStrategy: "insert",
        batchSize: 1_001,
        flushInterval: 50,
        logsSearchDualWriteActive: "by-id",
        logsSearchDualWriteOrganizationIds: new Set(["org_dual_write_test"]),
      });
      const sourceAndSearchCounts = clickhouse.reader.query({
        name: "count-dual-write-rows",
        query: `SELECT
          (SELECT count() FROM trigger_dev.task_events_v2
            WHERE environment_id = {environmentId: String}) AS source_count,
          (SELECT count() FROM trigger_dev.task_events_search_v2
            WHERE environment_id = {environmentId: String}) AS search_count`,
        params: z.object({ environmentId: z.string() }),
        schema: z.object({ source_count: z.coerce.number(), search_count: z.coerce.number() }),
      });

      try {
        const allowedEvents = Array.from({ length: 1_000 }, (_, index) =>
          event({ span_id: `span_allowed_${index}` })
        );
        (repository as any).addToBatch([
          ...allowedEvents,
          event({
            organization_id: "org_not_allowed",
            span_id: "span_not_allowed",
          }),
        ]);

        await vi.waitFor(
          async () => {
            const [queryError, rows] = await sourceAndSearchCounts({
              environmentId: "env_dual_write_test",
            });
            expect(queryError).toBeNull();
            expect(rows).toEqual([{ source_count: 1_001, search_count: 1_000 }]);

            const resourceMetrics = await latestMetrics(metrics);
            expect(
              metricSum(resourceMetrics, "logs_search.dual_write.rows_eligible", {
                table: "task_events_search_v2",
              })
            ).toBe(1_000);
            expect(
              metricSum(resourceMetrics, "logs_search.dual_write.rows_landed", {
                table: "task_events_search_v2",
              })
            ).toBe(1_000);
          },
          { timeout: 10_000, interval: 100 }
        );
      } finally {
        await shutdownRepository(repository);
        await metrics.shutdown();
        await clickhouse.close();
      }
    },
    60_000
  );

  clickhouseTest(
    "records mapping failures as dropped search rows",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        logLevel: "error",
      });
      const metrics = createInMemoryMetrics();
      const repository = new ClickhouseEventRepository({
        clickhouse,
        meter: metrics.meter,
        version: "v2",
        insertStrategy: "insert",
        batchSize: 1,
        flushInterval: 50,
        logsSearchDualWriteActive: "on",
      });
      const sourceCount = clickhouse.reader.query({
        name: "count-mapping-failure-source-rows",
        query: `SELECT count() AS count
          FROM trigger_dev.task_events_v2
          WHERE environment_id = {environmentId: String}`,
        params: z.object({ environmentId: z.string() }),
        schema: z.object({ count: z.coerce.number() }),
      });

      try {
        (repository as any).addToBatch([
          event({ start_time: new Date().toISOString().replace("T", " ").replace("Z", "") }),
        ]);

        await vi.waitFor(
          async () => {
            const [sourceError, rows] = await sourceCount({
              environmentId: "env_dual_write_test",
            });
            expect(sourceError).toBeNull();
            expect(rows?.[0]?.count).toBe(1);

            const resourceMetrics = await latestMetrics(metrics);
            expect(
              metricSum(resourceMetrics, "logs_search.dual_write.rows_dropped", {
                table: "task_events_search_v2",
                reason: "mapping_failed",
              })
            ).toBe(1);
            expect(
              metricSum(resourceMetrics, "logs_search.dual_write.batches", {
                table: "task_events_search_v2",
                outcome: "dropped",
              })
            ).toBe(1);
          },
          { timeout: 10_000, interval: 100 }
        );
      } finally {
        await shutdownRepository(repository);
        await metrics.shutdown();
        await clickhouse.close();
      }
    },
    60_000
  );

  clickhouseTest(
    "keeps the source insert successful when the search insert fails",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        logLevel: "error",
      });
      const metrics = createInMemoryMetrics();
      const repository = new ClickhouseEventRepository({
        clickhouse,
        meter: metrics.meter,
        version: "v2",
        insertStrategy: "insert",
        batchSize: 1,
        flushInterval: 50,
        logsSearchDualWriteActive: "on",
        logsSearchDualWriteMaxConcurrency: 1,
        logsSearchDualWriteMaxPending: 1,
      });
      const dropSearchTable = clickhouse.writer.command({
        name: "drop-search-table-for-dual-write-test",
        query: "DROP TABLE trigger_dev.task_events_search_v2",
      });
      const [dropError] = await dropSearchTable({});
      expect(dropError).toBeNull();

      const sourceCount = clickhouse.reader.query({
        name: "count-dual-write-source-rows",
        query: `SELECT count() AS count
          FROM trigger_dev.task_events_v2
          WHERE environment_id = {environmentId: String}`,
        params: z.object({ environmentId: z.string() }),
        schema: z.object({ count: z.coerce.number() }),
      });

      try {
        (repository as any).addToBatch([event()]);

        await vi.waitFor(
          async () => {
            const [sourceError, rows] = await sourceCount({
              environmentId: "env_dual_write_test",
            });
            expect(sourceError).toBeNull();
            expect(rows?.[0]?.count).toBe(1);

            const resourceMetrics = await latestMetrics(metrics);
            expect(
              metricSum(resourceMetrics, "logs_search.dual_write.batches", {
                table: "task_events_search_v2",
                outcome: "failed",
              })
            ).toBe(1);
            expect(
              metricSum(resourceMetrics, "logs_search.dual_write.rows_dropped", {
                table: "task_events_search_v2",
                reason: "insert_failed",
              })
            ).toBe(1);
          },
          { timeout: 10_000, interval: 100 }
        );
      } finally {
        await shutdownRepository(repository);
        await metrics.shutdown();
        await clickhouse.close();
      }
    },
    60_000
  );
});
