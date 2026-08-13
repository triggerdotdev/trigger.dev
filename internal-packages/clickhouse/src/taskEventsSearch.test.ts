import { clickhouseTest } from "@internal/testcontainers";
import { randomUUID } from "node:crypto";
import { ClickHouse } from "./index.js";

const ORG = "org_logs_search";
const PROJECT = "project_logs_search";
const ENVIRONMENT = "env_logs_search";

function event(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const start = now.toISOString().replace("T", " ").replace("Z", "");
  return {
    environment_id: ENVIRONMENT,
    organization_id: ORG,
    project_id: PROJECT,
    task_identifier: "search-task",
    run_id: "run_logs_search",
    start_time: start,
    duration: "1000000",
    trace_id: "trace_logs_search",
    span_id: `span_${randomUUID()}`,
    parent_span_id: "",
    message: "TypeError: Zahlungsübersicht failed, retrying /api/orders/42",
    kind: "LOG_ERROR",
    status: "ERROR",
    attributes: {
      request_id: "req_123",
      status_code: 500,
      retryable: true,
      error: { message: "Payment failed, retrying" },
    },
    metadata: "{}",
    expires_at: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", ""),
    inserted_at: start,
    ...overrides,
  };
}

describe("task events search v2", () => {
  clickhouseTest(
    "indexes bounded normalized text without losing common pasted searches",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });
      const [insertError] = await ch.taskEventsV2.insert([event()]);
      expect(insertError).toBeNull();

      // Use the fast builder because the fixture schema deliberately stays local to this test.
      const builder = ch.reader.queryBuilderFast<{
        search_text: string;
        error_message: string;
      }>({
        name: "read-search-v2-fixture",
        table: "trigger_dev.task_events_search_v2",
        columns: ["search_text", "error_message"],
      })();
      builder.where("organization_id = {organizationId: String}", { organizationId: ORG });
      const [readError, rows] = await builder.execute();
      expect(readError).toBeNull();
      expect(rows).toHaveLength(1);
      expect(rows?.[0].search_text).toContain(
        "typeerror: zahlungsübersicht failed retrying /api/orders/42"
      );
      expect(rows?.[0].search_text).toContain("status_code :500");
      expect(rows?.[0].search_text).toContain("retryable :true");
      expect(rows?.[0].error_message).toBe("Payment failed, retrying");

      await ch.close();
    }
  );

  clickhouseTest(
    "caps source work before normalization and clamps future timestamps",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });
      const [insertError] = await ch.taskEventsV2.insert([
        event({
          duration: "3153600000000000000",
          attributes: { prefix: "kept-token", payload: "x".repeat(100_000) },
        }),
      ]);
      expect(insertError).toBeNull();

      const builder = ch.reader.queryBuilderFast<{
        search_length: number;
        triggered_timestamp_ms: number;
      }>({
        name: "read-bounded-search-v2-fixture",
        table: "trigger_dev.task_events_search_v2",
        columns: [
          { name: "search_length", expression: "length(search_text)" },
          {
            name: "triggered_timestamp_ms",
            expression: "toUnixTimestamp64Milli(triggered_timestamp)",
          },
        ],
      })();
      builder.where("organization_id = {organizationId: String}", { organizationId: ORG });
      const [readError, rows] = await builder.execute();
      expect(readError).toBeNull();
      expect(rows).toHaveLength(1);
      expect(rows?.[0].search_length).toBeLessThanOrEqual(8192);
      expect(rows?.[0].triggered_timestamp_ms).toBeLessThanOrEqual(Date.now() + 6 * 60 * 1000);
      await ch.close();
    }
  );
});
