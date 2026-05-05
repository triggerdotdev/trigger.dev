import { clickhouseTest } from "@internal/testcontainers";
import { createClient } from "@clickhouse/client";
import { ClickhouseClient } from "./client/client.js";
import { insertTaskEventsV2, type TaskEventV2Input } from "./taskEvents.js";

describe("Task Events V2", () => {
  clickhouseTest(
    "insertTaskEventsV2 disables input_format_parallel_parsing",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insert = insertTaskEventsV2(client, {
        async_insert: 0,
      });

      const event: TaskEventV2Input = {
        environment_id: "env_test",
        organization_id: "org_test",
        project_id: "proj_test",
        task_identifier: "test-task",
        run_id: "run_test",
        start_time: "2026-01-01 00:00:00.000000000",
        duration: "1000",
        trace_id: "abc123",
        span_id: "def456",
        parent_span_id: "",
        message: "test message",
        kind: "SPAN",
        status: "OK",
        attributes: { test: "value" },
        metadata: "{}",
        expires_at: "2026-12-31 00:00:00.000",
      };

      const [insertError] = await insert([event]);
      expect(insertError).toBeNull();

      const rawClient = createClient({ url: clickhouseContainer.getConnectionUrl() });
      try {
        await rawClient.command({ query: "SYSTEM FLUSH LOGS" });

        const result = await rawClient.query({
          query: `
            SELECT Settings['input_format_parallel_parsing'] AS parallel_parsing
            FROM system.query_log
            WHERE event_time >= now() - INTERVAL 5 MINUTE
              AND query_kind = 'Insert'
              AND has(tables, 'trigger_dev.task_events_v2')
              AND type = 'QueryFinish'
            ORDER BY event_time DESC
            LIMIT 1
          `,
          format: "JSONEachRow",
        });

        const rows = (await result.json()) as Array<{ parallel_parsing: string }>;
        expect(rows[0]?.parallel_parsing).toBe("0");
      } finally {
        await rawClient.close();
      }
    }
  );
});
