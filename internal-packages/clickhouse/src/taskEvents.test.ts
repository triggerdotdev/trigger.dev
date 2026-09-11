import { clickhouseTest } from "@internal/testcontainers";
import { z } from "zod";
import { ClickHouse } from "./index.js";

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function baseEvent(spanId: string) {
  const startTime = new Date("2026-09-01T10:00:00.000Z");
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  return {
    environment_id: "env_attributes_text",
    organization_id: "org_attributes_text",
    project_id: "project_attributes_text",
    task_identifier: "attributes-text",
    run_id: "run_attributes_text",
    start_time: clickhouseDate(startTime),
    duration: "1000000",
    trace_id: "trace_attributes_text",
    span_id: spanId,
    parent_span_id: "",
    message: "Attributes text",
    kind: "SPAN",
    status: "OK",
    metadata: "{}",
    expires_at: clickhouseDate(expiresAt),
  };
}

const columnKindSchema = z.object({
  name: z.string(),
  default_kind: z.string(),
  default_expression: z.string(),
});

function readAttributesText(ch: ClickHouse) {
  return ch.reader.query({
    name: "read-task-event-attributes",
    query: `SELECT attributes_text,
      toJSONString(attributes) AS attributes_json,
      toUInt8(inserted_at > toDateTime64('2020-01-01 00:00:00', 3)) AS has_inserted_at
    FROM trigger_dev.task_events_v2
    WHERE environment_id = {environmentId: String}
      AND span_id = {spanId: String}`,
    params: z.object({ environmentId: z.string(), spanId: z.string() }),
    schema: z.object({
      attributes_text: z.string(),
      attributes_json: z.string(),
      has_inserted_at: z.number(),
    }),
  });
}

function readColumnKinds(ch: ClickHouse) {
  return ch.reader.query({
    name: "read-task-event-attribute-column-kinds",
    query: `SELECT name, default_kind, default_expression
    FROM system.columns
    WHERE database = 'trigger_dev'
      AND table = 'task_events_v2'
      AND name IN ('attributes', 'attributes_input', 'attributes_text')
    ORDER BY name`,
    schema: columnKindSchema,
  });
}

describe("task events v2", () => {
  clickhouseTest(
    "stores attributes_text serialized by the writer",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });
      const spanId = "span_serialized_attributes";

      const [insertError] = await ch.taskEventsV2.insert([
        {
          ...baseEvent(spanId),
          attributes: {
            z: 1,
            a: "hello",
            nested: { enabled: true },
          },
        },
      ]);
      expect(insertError).toBeNull();

      const [readError, rows] = await readAttributesText(ch)({
        environmentId: "env_attributes_text",
        spanId,
      });
      expect(readError).toBeNull();
      expect(rows).toEqual([
        {
          attributes_text: '{"z":1,"a":"hello","nested":{"enabled":true}}',
          // The JSON column is no longer written; only the text is stored.
          attributes_json: "{}",
          has_inserted_at: 1,
        },
      ]);
    }
  );

  clickhouseTest(
    "computes attributes_text for a writer that omits it",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });
      const spanId = "span_computed_attributes";

      // An older writer that only sends the JSON column still gets attributes_text
      // from the DEFAULT expression, so both writer generations can coexist.
      const insert = ch.writer.insertUnsafe<Record<string, unknown>>({
        name: "insertTaskEventsV2WithoutAttributesText",
        table: "trigger_dev.task_events_v2",
        columns: [
          "environment_id",
          "organization_id",
          "project_id",
          "task_identifier",
          "run_id",
          "start_time",
          "duration",
          "trace_id",
          "span_id",
          "parent_span_id",
          "message",
          "kind",
          "status",
          "attributes",
          "metadata",
          "expires_at",
        ],
        settings: { enable_json_type: 1 },
      });

      const [insertError] = await insert([
        {
          ...baseEvent(spanId),
          attributes: { z: 1, a: "hello" },
        },
      ]);
      expect(insertError).toBeNull();

      const [readError, rows] = await readAttributesText(ch)({
        environmentId: "env_attributes_text",
        spanId,
      });
      expect(readError).toBeNull();
      expect(rows).toEqual([
        {
          attributes_text: '{"a":"hello","z":1}',
          attributes_json: '{"a":"hello","z":1}',
          has_inserted_at: 1,
        },
      ]);
    }
  );

  clickhouseTest("attributes_text is a DEFAULT column", async ({ clickhouseContainer }) => {
    const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });

    const [columnError, columns] = await readColumnKinds(ch)({});
    expect(columnError).toBeNull();
    expect(columns).toEqual([
      { name: "attributes", default_kind: "", default_expression: "" },
      {
        name: "attributes_input",
        default_kind: "EPHEMERAL",
        default_expression: "defaultValueOfTypeName('JSON')",
      },
      {
        name: "attributes_text",
        default_kind: "DEFAULT",
        default_expression: "toJSONString(attributes)",
      },
    ]);
  });

  clickhouseTest("has no attributes text indexes", async ({ clickhouseContainer }) => {
    const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });
    const readRemovedIndexes = ch.reader.query({
      name: "read-removed-task-event-text-indexes",
      query: `SELECT name
      FROM system.data_skipping_indices
      WHERE database = 'trigger_dev'
        AND table = 'task_events_v2'
        AND name IN (
          'idx_attributes_text_search',
          'idx_attributes_text',
          'idx_message_text_search',
          'message_text_search'
        )
      ORDER BY name`,
      schema: z.object({ name: z.string() }),
    });
    const [indexError, indexes] = await readRemovedIndexes({});
    expect(indexError).toBeNull();
    expect(indexes).toEqual([]);
  });
});
