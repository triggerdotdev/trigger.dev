import { clickhouseTest } from "@internal/testcontainers";
import { z } from "zod";
import { ClickHouse } from "./index.js";

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

describe("task events v2", () => {
  clickhouseTest(
    "stores materialized attributes with explicit insert columns",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });
      const now = new Date("2026-09-01T10:00:00.000Z");
      const spanId = "span_ephemeral_attributes";

      const [insertError] = await ch.taskEventsV2.insert([
        {
          environment_id: "env_ephemeral_attributes",
          organization_id: "org_ephemeral_attributes",
          project_id: "project_ephemeral_attributes",
          task_identifier: "ephemeral-attributes",
          run_id: "run_ephemeral_attributes",
          start_time: clickhouseDate(now),
          duration: "1000000",
          trace_id: "trace_ephemeral_attributes",
          span_id: spanId,
          parent_span_id: "",
          message: "Ephemeral attributes",
          kind: "SPAN",
          status: "OK",
          attributes: {
            z: 1,
            a: "hello",
            nested: { enabled: true },
          },
          metadata: "{}",
          expires_at: clickhouseDate(new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)),
        },
      ]);
      expect(insertError).toBeNull();

      const readAttributes = ch.reader.query({
        name: "read-ephemeral-task-event-attributes",
        query: `SELECT attributes_text,
          toUInt8(inserted_at > toDateTime64('2020-01-01 00:00:00', 3)) AS has_inserted_at
        FROM trigger_dev.task_events_v2
        WHERE environment_id = {environmentId: String}
          AND span_id = {spanId: String}`,
        params: z.object({ environmentId: z.string(), spanId: z.string() }),
        schema: z.object({ attributes_text: z.string(), has_inserted_at: z.number() }),
      });
      const [readError, rows] = await readAttributes({
        environmentId: "env_ephemeral_attributes",
        spanId,
      });
      expect(readError).toBeNull();
      expect(rows).toEqual([
        {
          attributes_text: '{"a":"hello","nested":{"enabled":true},"z":1}',
          has_inserted_at: 1,
        },
      ]);

    }
  );
});
