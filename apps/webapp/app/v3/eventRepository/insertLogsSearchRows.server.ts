import type { ClickHouse, ClickHouseSettings, TaskEventSearchV2Input } from "@internal/clickhouse";
import {
  insertWithBadRowSkip,
  isClickHouseJsonParseError,
  type JsonParseRecoveryLogger,
} from "./sanitizeRowsOnParseError.server";

const ASYNC_INSERT_SETTINGS = {
  async_insert: 1,
  wait_for_async_insert: 1,
  // Older compatibility profiles disable async deduplication by default.
  deduplicate_insert: "enable",
  async_insert_busy_timeout_ms: 1000,
  async_insert_use_adaptive_busy_timeout: 0,
} as const satisfies ClickHouseSettings;

export function insertLogsSearchRows(
  insertRows: ClickHouse["taskEventsSearch"]["insert"],
  flushId: string,
  rows: TaskEventSearchV2Input[],
  logger: JsonParseRecoveryLogger,
  asyncInsert = false
) {
  const insert = async (batch: TaskEventSearchV2Input[], settings?: ClickHouseSettings) => {
    const [error, result] = await insertRows(batch, {
      params: {
        clickhouse_settings: {
          ...(asyncInsert ? ASYNC_INSERT_SETTINGS : { async_insert: 0 as const }),
          insert_deduplication_token: flushId,
          ...settings,
        },
      },
    });
    if (error) throw error;
    return result;
  };

  return insertWithBadRowSkip({
    rows,
    contextLabel: "task_events_search_v2",
    logger,
    logContext: { flushId },
    hasMaterializedViews: false,
    isParseError: (error) =>
      isClickHouseJsonParseError(error) ||
      (typeof error === "object" &&
        error !== null &&
        "clickhouseErrorType" in error &&
        error.clickhouseErrorType === "CANNOT_PARSE_ESCAPE_SEQUENCE"),
    insert: (batch) => insert(batch),
    insertAllowingBadRows: (batch) =>
      insert(batch, {
        input_format_parallel_parsing: 0,
        input_format_allow_errors_num: String(batch.length),
        input_format_allow_errors_ratio: 1,
      }),
  });
}
