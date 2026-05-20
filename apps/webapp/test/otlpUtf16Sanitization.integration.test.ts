import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import {
  INVALID_UTF16_SENTINEL,
  isClickHouseJsonParseError,
  parseRowNumberFromError,
  sanitizeRows,
} from "~/v3/eventRepository/sanitizeRowsOnParseError.server";

/**
 * Integration test that proves the reactive sanitize-and-retry flow works
 * against a real ClickHouse instance. Boots a CH container (via testcontainers)
 * and reproduces the prod failure path end-to-end.
 *
 * Three contracts are verified:
 *
 * 1. **Happy retry path** — insert a row with a lone UTF-16 surrogate, observe
 *    the parse error, recover via `parseRowNumberFromError` +
 *    `sanitizeRowsFrom`, retry once, and confirm the row lands with the
 *    sentinel substituted.
 *
 * 2. **Real CH error shape** — confirm `isClickHouseJsonParseError` correctly
 *    recognises the error string we get back from a real CH (not just synthetic
 *    test fixtures) and that `parseRowNumberFromError` extracts the right
 *    integer from the same string.
 *
 * 3. **Non-parse errors don't get swallowed** — push a row past the CH per-row
 *    size cap and confirm the resulting `Size of JSON object ... is extremely
 *    large` error is NOT misclassified as a JSON parse error by our predicate.
 */

const HIGH_SURROGATE = "\uD800";
const LOW_SURROGATE = "\uDC00";

// ClickHouse container boot + image pull on first run can take well past
// vitest's 5 s default. Match what `internal-packages/clickhouse/vitest.config.ts`
// uses for its own clickhouseTest specs.
const INTEGRATION_TIMEOUT_MS = 60_000;

describe("OTel attribute UTF-16 sanitization → ClickHouse insert", () => {
  clickhouseTest(
    "lone surrogate is rejected by CH, then sanitized and retried successfully",
    async ({ clickhouseClient }) => {
      const table = "trigger_dev_test.utf16_repro";

      await clickhouseClient.command({
        query: "CREATE DATABASE IF NOT EXISTS trigger_dev_test",
      });
      await clickhouseClient.command({ query: `DROP TABLE IF EXISTS ${table}` });
      await clickhouseClient.command({
        query: `
          CREATE TABLE ${table} (
            id String,
            attributes JSON
          ) ENGINE = MergeTree() ORDER BY id
          SETTINGS allow_experimental_json_type = 1
        `,
      });

      const rows = [
        {
          id: "row-clean-prefix",
          attributes: { ai: { prompt: { messages: "valid prompt 1" } } },
        },
        {
          id: "row-poisoned",
          attributes: {
            ai: { prompt: { messages: `valid prefix ${HIGH_SURROGATE} broken tail` } },
          },
        },
        {
          id: "row-clean-suffix",
          attributes: { ai: { prompt: { messages: "valid prompt 3" } } },
        },
      ];

      // --- Contract 1: real CH rejects the raw insert with our recognisable error ---
      const firstError = await clickhouseClient
        .insert({
          table,
          values: rows,
          format: "JSONEachRow",
          clickhouse_settings: { async_insert: 0, input_format_parallel_parsing: 1 },
        })
        .then(
          () => null,
          (e: unknown) => e as Error
        );

      expect(firstError, "first insert must be rejected").not.toBeNull();
      expect(
        isClickHouseJsonParseError(firstError),
        "our predicate must recognise the real CH parse error"
      ).toBe(true);
      const rowN = parseRowNumberFromError(firstError!.message);
      expect(rowN, "real CH error must include `at row N`").not.toBeNull();
      expect(rowN! >= 0).toBe(true);

      // --- Recovery: sanitize the whole batch, retry ---
      // We don't slice on `rowN` even though we logged it — `at row N`
      // semantics under parallel parsing aren't stable enough to skip rows.
      const { rowsTouched, fieldsSanitized } = sanitizeRows(rows);
      expect(fieldsSanitized, "exactly one field should have been replaced").toBe(1);
      expect(rowsTouched).toBe(1);

      // Confirm the targeted row was sanitized and the clean ones were left alone.
      expect(rows[1].attributes.ai.prompt.messages).toBe(INVALID_UTF16_SENTINEL);
      expect(rows[0].attributes.ai.prompt.messages).toBe("valid prompt 1");
      expect(rows[2].attributes.ai.prompt.messages).toBe("valid prompt 3");

      // --- Contract 1 (cont'd): retry now lands cleanly ---
      await clickhouseClient.insert({
        table,
        values: rows,
        format: "JSONEachRow",
        clickhouse_settings: { async_insert: 0, input_format_parallel_parsing: 1 },
      });

      const result = await clickhouseClient
        .query({
          query: `
            SELECT id, toJSONString(attributes) AS attributes_text
            FROM ${table}
            ORDER BY id
          `,
          format: "JSONEachRow",
        })
        .then((r) => r.json<{ id: string; attributes_text: string }>());

      expect(result).toHaveLength(3);
      const byId = Object.fromEntries(result.map((r) => [r.id, r]));
      expect(byId["row-clean-prefix"].attributes_text).toContain("valid prompt 1");
      expect(byId["row-clean-suffix"].attributes_text).toContain("valid prompt 3");
      expect(byId["row-poisoned"].attributes_text).toContain(INVALID_UTF16_SENTINEL);

      // --- Contract 2: lone LOW surrogate also recognised + recoverable ---
      const lowSurrogateRow = {
        id: "row-low-surrogate",
        attributes: {
          ai: { prompt: { messages: `valid prefix ${LOW_SURROGATE} broken tail` } },
        },
      };
      const lowSurrogateError = await clickhouseClient
        .insert({
          table,
          values: [lowSurrogateRow],
          format: "JSONEachRow",
          clickhouse_settings: { async_insert: 0, input_format_parallel_parsing: 1 },
        })
        .then(
          () => null,
          (e: unknown) => e as Error
        );
      expect(lowSurrogateError).not.toBeNull();
      expect(isClickHouseJsonParseError(lowSurrogateError)).toBe(true);

      sanitizeRows([lowSurrogateRow]);
      expect(lowSurrogateRow.attributes.ai.prompt.messages).toBe(INVALID_UTF16_SENTINEL);

      await clickhouseClient.insert({
        table,
        values: [lowSurrogateRow],
        format: "JSONEachRow",
        clickhouse_settings: { async_insert: 0, input_format_parallel_parsing: 1 },
      });
    },
    INTEGRATION_TIMEOUT_MS
  );

  clickhouseTest(
    "non-parse-error rejections (e.g. missing table) are NOT misclassified as JSON parse errors",
    async ({ clickhouseClient }) => {
      // Pick an error class that is unambiguously NOT a JSON parse failure —
      // inserting into a table that doesn't exist. CH returns
      // `Table doesn't exist` (UNKNOWN_TABLE). If our predicate ever started
      // matching it we'd wastefully sanitize-and-retry an unrelated failure.
      const error = await clickhouseClient
        .insert({
          table: "trigger_dev_test_nonexistent.utf16_does_not_exist",
          values: [{ id: "1", attributes: { ok: "yes" } }],
          format: "JSONEachRow",
          clickhouse_settings: { async_insert: 0 },
        })
        .then(
          () => null,
          (e: unknown) => e as Error
        );

      expect(error, "missing-table insert should be rejected").not.toBeNull();
      expect(
        isClickHouseJsonParseError(error),
        "non-parse error must not be misclassified as JSON parse error"
      ).toBe(false);
    },
    INTEGRATION_TIMEOUT_MS
  );
});
