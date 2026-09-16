import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClickHouse } from "./index.js";
import {
  boundedUtf8,
  buildSearchText,
  isTaskEventSearchEligible,
  toTaskEventSearchV2Row,
} from "./taskEventsSearch.js";
import type { TaskEventV2Input } from "./taskEvents.js";

const ORGANIZATION_ID = "org_logs_search";

function formatNanoseconds(value: bigint): string {
  return `${value / 1_000_000_000n}.${(value % 1_000_000_000n).toString().padStart(9, "0")}`;
}

function event(overrides: Partial<TaskEventV2Input> = {}): TaskEventV2Input {
  const now = BigInt(Date.parse("2026-09-14T10:00:00.000Z")) * 1_000_000n;

  return {
    environment_id: "env_logs_search",
    organization_id: ORGANIZATION_ID,
    project_id: "project_logs_search",
    task_identifier: "search-task",
    run_id: "run_logs_search",
    start_time: formatNanoseconds(now),
    duration: "1000000",
    trace_id: "trace_logs_search",
    span_id: "span_logs_search",
    parent_span_id: "",
    message: "TypeError: Zahlungsübersicht failed, retrying /api/orders/42",
    kind: "LOG_ERROR",
    status: "ERROR",
    attributes: {
      request_id: "req_123",
      error: { message: "Payment failed, retrying" },
    },
    metadata: "{}",
    expires_at: "2026-12-13 10:00:00.000",
    ...overrides,
  };
}

describe("task events search eligibility", () => {
  it("matches the search table predicates", () => {
    expect(isTaskEventSearchEligible(event())).toBe(true);
    expect(isTaskEventSearchEligible(event({ trace_id: "" }))).toBe(false);
    expect(isTaskEventSearchEligible(event({ kind: "DEBUG_EVENT" }))).toBe(false);
    expect(isTaskEventSearchEligible(event({ status: "PARTIAL" }))).toBe(false);
    expect(isTaskEventSearchEligible(event({ kind: "ANCESTOR_OVERRIDE" }))).toBe(false);
    expect(isTaskEventSearchEligible(event({ message: "trigger.dev/start" }))).toBe(false);
  });

  it("only drops span events whose attributes serialize to an empty object", () => {
    expect(isTaskEventSearchEligible(event({ kind: "SPAN_EVENT", attributes: {} }))).toBe(false);
    expect(isTaskEventSearchEligible(event({ kind: "SPAN_EVENT", attributes: null }))).toBe(false);
    expect(isTaskEventSearchEligible(event({ kind: "SPAN_EVENT", attributes: undefined }))).toBe(
      false
    );
    expect(
      isTaskEventSearchEligible(event({ kind: "SPAN_EVENT", attributes: { a: undefined } }))
    ).toBe(false);
    expect(isTaskEventSearchEligible(event({ kind: "SPAN_EVENT", attributes: { a: 1 } }))).toBe(
      true
    );
    expect(isTaskEventSearchEligible(event({ kind: "SPAN_EVENT", attributes: [] }))).toBe(true);
  });
});

describe("task events search mapping", () => {
  it("maps normalized text, errors, and completion timestamps", () => {
    const now = new Date("2026-09-14T10:00:10.000Z");
    const row = toTaskEventSearchV2Row(event(), now);

    expect(row.error_message).toBe("Payment failed, retrying");
    expect(row.search_text).toContain("typeerror:zahlungsübersicht failed retrying /api/orders/42");
    expect(row.search_text).toContain("request_id:req_123");
    expect(row.triggered_timestamp).toBe("1789380000.001000000");
    expect(row.inserted_at).toBe("2026-09-14 10:00:10.000");
    expect(row).not.toHaveProperty("projection_fingerprint");
  });

  it("uses a source insertion timestamp and clamps completion timestamps", () => {
    const now = new Date("2026-09-14T10:00:10.000Z");
    const row = toTaskEventSearchV2Row(
      event({
        duration: "18446744073709551615",
        inserted_at: "2026-09-14 09:59:59.123",
      }),
      now
    );

    expect(row.inserted_at).toBe("2026-09-14 09:59:59.123");
    expect(row.triggered_timestamp).toBe("1789380299.123000000");
  });

  it("bounds multibyte fields as valid UTF-8", () => {
    const boundary = `${"x".repeat(2044)}€tail`;
    const row = toTaskEventSearchV2Row(
      event({
        message: boundary,
        attributes: {
          value: "€".repeat(3000),
          error: { message: boundary },
        },
      }),
      new Date("2026-09-14T10:00:10.000Z")
    );

    expect(Buffer.byteLength(row.error_message)).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(row.search_text)).toBeLessThanOrEqual(8192);
    expect(Buffer.from(row.error_message).toString("utf8")).toBe(row.error_message);
    expect(Buffer.from(row.search_text).toString("utf8")).toBe(row.search_text);
    expect(Buffer.byteLength(boundedUtf8("€".repeat(3000), 6140))).toBeLessThanOrEqual(6143);
  });

  it("does not throw on unexpected error attribute shapes", () => {
    expect(
      toTaskEventSearchV2Row(event({ attributes: { error: "nope" } }), new Date()).error_message
    ).toBe("");
    expect(
      toTaskEventSearchV2Row(event({ attributes: { error: { message: 123 } } }), new Date())
        .error_message
    ).toBe("");
  });
});

describe("task events search ClickHouse integration", () => {
  clickhouseTest(
    "inserts rows and deduplicates retries by token",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });
      const enableLocalDeduplication = ch.writer.command({
        name: "enable-local-search-table-deduplication",
        query: `ALTER TABLE trigger_dev.task_events_search_v2
          MODIFY SETTING non_replicated_deduplication_window = 1000`,
      });
      const [settingError] = await enableLocalDeduplication({});
      expect(settingError).toBeNull();

      const row = toTaskEventSearchV2Row(event(), new Date("2026-09-14T10:00:10.000Z"));
      const options = {
        params: {
          clickhouse_settings: {
            async_insert: 0 as const,
            insert_deduplication_token: "logs-search-retry-token",
          },
        },
      };

      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const [error] = await ch.taskEventsSearch.insert(row, options);
          expect(error).toBeNull();
        }

        const query = ch.reader.query({
          name: "read-inserted-search-row",
          query: `SELECT
          count() AS count,
          countIf(inserted_at > toDateTime64('2020-01-01', 3)) AS timestamps,
          countIf(projection_fingerprint != 0) AS fingerprints
        FROM trigger_dev.task_events_search_v2
        WHERE organization_id = {organizationId: String}`,
          params: z.object({ organizationId: z.string() }),
          schema: z.object({
            count: z.coerce.number(),
            timestamps: z.coerce.number(),
            fingerprints: z.coerce.number(),
          }),
        });
        const [queryError, rows] = await query({ organizationId: ORGANIZATION_ID });

        expect(queryError).toBeNull();
        expect(rows).toEqual([{ count: 1, timestamps: 1, fingerprints: 1 }]);
      } finally {
        await ch.close();
      }
    }
  );

  clickhouseTest(
    "matches the ClickHouse normalization expression",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });
      const normalize = ch.reader.query({
        name: "normalize-search-text-in-clickhouse",
        query: `SELECT toValidUTF8(substring(
        replaceRegexpAll(
          replaceRegexpAll(
            lowerUTF8(concat(
              toValidUTF8(substring({message: String}, 1, 2045)),
              ' ',
              replaceAll(
                toValidUTF8(substring({attributesText: String}, 1, 6140)),
                '\\\\/',
                '/'
              )
            )),
            '[^\\\\p{L}\\\\p{N}_./:@+-]+',
            ' '
          ),
          '\\\\s*:\\\\s*',
          ':'
        ),
        1,
        8189
      )) AS search_text`,
        params: z.object({ message: z.string(), attributesText: z.string() }),
        schema: z.object({ search_text: z.string() }),
      });
      const cases = [
        ["TypeError: Zahlungsübersicht failed", '{"status_code": 500}'],
        ["I İ ı İSTANBUL ΟΣ", '{"path":"\\/api\\/orders"}'],
        [`${"x".repeat(2044)}€tail`, JSON.stringify({ value: "€".repeat(3000) })],
        ...Array.from({ length: 20 }, (_, index) => [
          `Fuzz ${index}: /api/items/${index} !@#$%^&*() 日本語`,
          JSON.stringify({ index, value: `value_${index}`, enabled: index % 2 === 0 }),
        ]),
      ];

      try {
        for (const [message, attributesText] of cases) {
          const [error, rows] = await normalize({ message, attributesText });
          expect(error).toBeNull();
          expect(rows?.[0]?.search_text).toBe(buildSearchText(message, attributesText));
        }
      } finally {
        await ch.close();
      }
    }
  );
});
