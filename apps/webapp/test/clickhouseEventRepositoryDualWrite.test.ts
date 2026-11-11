import {
  ClickHouse,
  TASK_EVENT_SEARCH_V2_INSERT_COLUMNS,
  toTaskEventSearchV2Row,
  type TaskEventSearchV2Input,
  type TaskEventV2Input,
} from "@internal/clickhouse";
import { ClickHouseContainer, clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import {
  ClickhouseEventRepository,
  logsSearchRolloutSelectedRowCount,
} from "~/v3/eventRepository/clickhouseEventRepository.server";
import { insertLogsSearchRows } from "~/v3/eventRepository/insertLogsSearchRows.server";
import {
  INVALID_UTF16_SENTINEL,
  insertWithBadRowSkip,
} from "~/v3/eventRepository/sanitizeRowsOnParseError.server";
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
  clickhouseTest.for([false, true])(
    "writes eligible rows for configured organizations (async insert: %s)",
    async (logsSearchInsertAsync, { clickhouseContainer }) => {
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
        logsSearchInsertAsync,
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
          event({
            span_id: `span_allowed_${index}`,
            message: index === 500 ? "broken \uD800 escape" : "source write survives",
          })
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

  clickhouseTest.for([false, true])(
    "recovers a strict search insert without losing neighboring rows (async insert: %s)",
    async (asyncInsert, { clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        logLevel: "error",
      });
      const strictInsert = clickhouse.writer.insertUnsafe<TaskEventSearchV2Input>({
        name: "strict-search-insert",
        table: "trigger_dev.task_events_search_v2",
        columns: TASK_EVENT_SEARCH_V2_INSERT_COLUMNS,
        settings: { input_format_json_throw_on_bad_escape_sequence: 1 },
      });
      const rows = ["clean prefix", "broken \uD800 escape", "clean suffix"].map((message, index) =>
        toTaskEventSearchV2Row(event({ message, span_id: `span_${index}` }), new Date())
      );
      const readMessages = clickhouse.reader.query({
        name: "read-recovered-search-messages",
        query: `SELECT message FROM trigger_dev.task_events_search_v2
          WHERE environment_id = {environmentId: String} ORDER BY span_id`,
        params: z.object({ environmentId: z.string() }),
        schema: z.object({ message: z.string() }),
      });

      try {
        const [error] = await strictInsert(rows);
        expect(error?.clickhouseErrorType).toBe("CANNOT_PARSE_ESCAPE_SEQUENCE");
        const insert = async (batch: TaskEventSearchV2Input[]) => {
          const [insertError, result] = await strictInsert(batch);
          if (insertError) throw insertError;
          return result;
        };
        await expect(
          insertWithBadRowSkip({
            rows,
            contextLabel: "default-recovery",
            logger: console,
            insert,
            insertAllowingBadRows: insert,
          })
        ).rejects.toMatchObject({ clickhouseErrorType: "CANNOT_PARSE_ESCAPE_SEQUENCE" });
        const outcome = await insertLogsSearchRows(
          strictInsert,
          "strict-recovery",
          rows,
          console,
          asyncInsert
        );
        expect(outcome.kind).toBe("sanitized");
        const [queryError, messages] = await readMessages({ environmentId: "env_dual_write_test" });
        expect(queryError).toBeNull();
        expect(messages).toEqual([
          { message: "clean prefix" },
          { message: INVALID_UTF16_SENTINEL },
          { message: "clean suffix" },
        ]);
      } finally {
        await clickhouse.close();
      }
    },
    60_000
  );

  // Catches: distinct retry tokens preventing coalescing, or legacy compatibility disabling retry deduplication.
  clickhouseTest(
    "coalesces distinct-token async inserts, deduplicates retries, and surfaces flush errors",
    async ({ clickhouseClient: schemaClient }) => {
      const ddlResult = await schemaClient.query({
        query: "SHOW CREATE TABLE trigger_dev.task_events_search_v2",
        format: "JSONEachRow",
      });
      const [{ statement }] = await ddlResult.json<{ statement: string }>();
      const container = await new ClickHouseContainer(
        "clickhouse/clickhouse-server:26.6@sha256:2c870d77ea76e955fb1c8dad536ad40a1236b6093db0c4966e22d21d4428982b"
      )
        .withCopyContentToContainer([
          {
            target: "/etc/clickhouse-server/config.d/keeper.xml",
            content: `<clickhouse>
              <keeper_server>
                <tcp_port>9181</tcp_port><server_id>1</server_id>
                <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>
                <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>
                <raft_configuration><server>
                  <id>1</id><hostname>localhost</hostname><port>9234</port>
                </server></raft_configuration>
              </keeper_server>
              <zookeeper><node><host>localhost</host><port>9181</port></node></zookeeper>
            </clickhouse>`,
          },
          {
            target: "/etc/clickhouse-server/users.d/compatibility.xml",
            content: `<clickhouse><profiles><default>
              <compatibility>24.12</compatibility>
              <async_insert_deduplicate>0</async_insert_deduplicate>
            </default></profiles></clickhouse>`,
          },
        ])
        .start();
      const clickhouse = new ClickHouse({
        url: container.getConnectionUrl(),
        logLevel: "error",
      });
      const clickhouseClient = clickhouse.writer.client;
      const row = toTaskEventSearchV2Row(event(), new Date());

      try {
        const settingsResult = await clickhouseClient.query({
          query: `SELECT getSetting('compatibility') AS compatibility,
            getSetting('deduplicate_insert') AS deduplication,
            getSetting('async_insert_deduplicate') AS async_deduplication`,
          format: "JSONEachRow",
        });
        expect(await settingsResult.json()).toEqual([
          {
            compatibility: "24.12",
            deduplication: "backward_compatible_choice",
            async_deduplication: false,
          },
        ]);
        await clickhouseClient.command({ query: "CREATE DATABASE trigger_dev" });
        await clickhouseClient.command({
          query: statement.replace(
            "ENGINE = ReplacingMergeTree",
            "ENGINE = ReplicatedReplacingMergeTree('/clickhouse/test/logs_search_async', 'replica1')"
          ),
        });
        await clickhouseClient.command({
          query: "SYSTEM STOP MERGES trigger_dev.task_events_search_v2",
        });

        const batchCount = 8;
        const tokens = Array.from(
          { length: batchCount },
          (_, index) => `async-search-batch-${index}`
        );
        await Promise.all(
          tokens.map((token, index) =>
            insertLogsSearchRows(
              clickhouse.taskEventsSearch.insert,
              token,
              [{ ...row, span_id: `span_async_${index}` }],
              console,
              true
            )
          )
        );
        await insertLogsSearchRows(
          clickhouse.taskEventsSearch.insert,
          tokens[0],
          [{ ...row, span_id: "span_async_0" }],
          console,
          true
        );

        const result = await clickhouseClient.query({
          query: `SELECT count() AS count, uniqExact(_part) AS parts
            FROM trigger_dev.task_events_search_v2
            WHERE environment_id = 'env_dual_write_test'`,
          format: "JSONEachRow",
        });
        const [counts] = await result.json<{ count: string; parts: string }>();
        expect(Number(counts.count)).toBe(batchCount);
        expect(Number(counts.parts)).toBeLessThan(batchCount);

        await clickhouseClient.command({ query: "SYSTEM FLUSH LOGS" });
        const asyncLogResult = await clickhouseClient.query({
          query: `SELECT count() AS count, uniqExact(flush_query_id) AS flushes
            FROM system.asynchronous_insert_log
            WHERE database = 'trigger_dev' AND table = 'task_events_search_v2' AND status = 'Ok'`,
          format: "JSONEachRow",
        });
        const [asyncLogs] = await asyncLogResult.json<{ count: string; flushes: string }>();
        expect(Number(asyncLogs.count)).toBe(batchCount + 1);
        expect(Number(asyncLogs.flushes)).toBeLessThan(batchCount);

        await clickhouseClient.command({
          query: `ALTER TABLE trigger_dev.task_events_search_v2
            ADD CONSTRAINT reject_search_message CHECK message != 'reject this search event'`,
        });
        await expect(
          insertLogsSearchRows(
            clickhouse.taskEventsSearch.insert,
            "rejected-search-batch",
            [{ ...row, message: "reject this search event" }],
            console,
            true
          )
        ).rejects.toMatchObject({ clickhouseErrorType: "VIOLATED_CONSTRAINT" });
      } finally {
        await clickhouse.close();
        await container.stop({ timeout: 0 });
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
        expect(
          metricSum(await latestMetrics(metrics), "logs_search.dual_write.rows_dropped", {
            table: "task_events_search_v2",
            reason: "mapping_failed",
          })
        ).toBe(0);
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
