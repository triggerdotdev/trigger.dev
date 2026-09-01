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
      const startTime = new Date("2026-09-01T10:00:00.000Z");
      const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      const spanId = "span_ephemeral_attributes";

      const [insertError] = await ch.taskEventsV2.insert([
        {
          environment_id: "env_ephemeral_attributes",
          organization_id: "org_ephemeral_attributes",
          project_id: "project_ephemeral_attributes",
          task_identifier: "ephemeral-attributes",
          run_id: "run_ephemeral_attributes",
          start_time: clickhouseDate(startTime),
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
          expires_at: clickhouseDate(expiresAt),
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

      const readColumnKinds = ch.reader.query({
        name: "read-task-event-attribute-column-kinds",
        query: `SELECT name, default_kind, default_expression
        FROM system.columns
        WHERE database = 'trigger_dev'
          AND table = 'task_events_v2'
          AND name IN ('attributes', 'attributes_text')
        ORDER BY name`,
        schema: z.object({
          name: z.string(),
          default_kind: z.string(),
          default_expression: z.string(),
        }),
      });
      const [columnError, columns] = await readColumnKinds({});
      expect(columnError).toBeNull();
      expect(columns).toEqual([
        {
          name: "attributes",
          default_kind: "EPHEMERAL",
          default_expression: "defaultValueOfTypeName('JSON')",
        },
        {
          name: "attributes_text",
          default_kind: "MATERIALIZED",
          default_expression: "toJSONString(attributes)",
        },
      ]);

      const readRemovedIndexes = ch.reader.query({
        name: "read-removed-task-event-text-indexes",
        query: `SELECT name
        FROM system.data_skipping_indices
        WHERE database = 'trigger_dev'
          AND table = 'task_events_v2'
          AND name IN ('idx_attributes_text_search', 'idx_message_text_search')
        ORDER BY name`,
        schema: z.object({ name: z.string() }),
      });
      const [indexError, indexes] = await readRemovedIndexes({});
      expect(indexError).toBeNull();
      expect(indexes).toEqual([]);
    }
  );
});
