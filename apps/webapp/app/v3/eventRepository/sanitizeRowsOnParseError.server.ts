import { detectBadJsonStrings } from "~/utils/detectBadJsonStrings";

/**
 * Replacement string we substitute for any attribute value that contains
 * a lone UTF-16 surrogate. JSON-safe, distinctly recognisable in logs and
 * the dashboard so operators can spot affected rows.
 */
export const INVALID_UTF16_SENTINEL = "[invalid-utf16]";

/**
 * ClickHouse's `JSON(max_dynamic_paths)` column fits each bare-integer
 * JSON token into Int64 (signed) or UInt64 (unsigned). Bare integers
 * outside `[-2^63, 2^64 - 1]` are rejected with `INCORRECT_DATA` (no
 * silent fallback to Float64). `JSON.stringify` emits any integer-valued
 * Number with `|value| < 1e21` as a bare integer (no exponent), so any
 * JS Number above ~9.2e18 that *happens* to be integer-valued lands on
 * the wire as a token CH cannot accept.
 *
 * The fix: replace such Numbers with their string form. CH's dynamic
 * JSON column accepts a `String` subtype on the same path, so the row
 * inserts cleanly on retry. The numeric value was already
 * precision-lossy upstream (JS Number can't represent integers above
 * 2^53 faithfully), so type-flipping to string is information-preserving
 * relative to what arrived.
 *
 * Float-valued numbers (including very large ones like `1e25`) serialise
 * with an exponent and are accepted by CH at any magnitude, so they're
 * left alone.
 */
const UINT64_MAX = 18446744073709551615n;
const INT64_MIN = -9223372036854775808n;

function isUnsafeJsonInteger(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (!Number.isInteger(value)) return false;
  // JSON.stringify emits integer-valued Numbers as bare integer tokens
  // (no exponent) only while `|value| < 1e21`; at or above that
  // threshold `Number.prototype.toString` switches to exponential form,
  // which CH accepts as Float64 at any magnitude. So the dangerous band
  // is strictly between the Int64/UInt64 boundary and 1e21.
  if (Math.abs(value) >= 1e21) return false;
  // Compare via BigInt for exactness. The Number literal 18446744073709551615
  // is rounded to 2**64 in float64 (the float spacing near 2^64 is 2048), so a
  // direct `value > 18446744073709551615` would miss a Number whose float64
  // value is exactly 2**64 — `JSON.stringify` of that emits
  // "18446744073709552000", which exceeds UInt64.MAX and ClickHouse rejects.
  // `BigInt(value)` is safe here because we already gated on Number.isInteger.
  const asBigInt = BigInt(value);
  return asBigInt > UINT64_MAX || asBigInt < INT64_MIN;
}

export type SanitizeResult = {
  /** How many rows had at least one string field replaced. */
  rowsTouched: number;
  /** Total count of string fields replaced across all sanitized rows. */
  fieldsSanitized: number;
};

/**
 * Recognises ClickHouse's "Cannot parse JSON object" rejection — the
 * deterministic-failure class our sanitizer is designed for. Bubbles up
 * from `@clickhouse/client` as an `InsertError` whose `.message` retains
 * the original ClickHouse error text.
 */
export function isClickHouseJsonParseError(err: unknown): boolean {
  if (!err) return false;
  const message =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message?: unknown }).message ?? "")
      : String(err);
  return message.includes("Cannot parse JSON object");
}

/**
 * Extracts the row index ClickHouse reported as the first to fail
 * (`(at row N)`). Returns `null` if the message doesn't include one —
 * caller should treat that as "sanitize from row 0".
 */
export function parseRowNumberFromError(errorMessage: string): number | null {
  const match = errorMessage.match(/at row (\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Walks `value` recursively and replaces any string leaf that contains a
 * lone UTF-16 surrogate with `INVALID_UTF16_SENTINEL`. Mutates objects
 * and arrays in place; primitives are returned unchanged.
 *
 * Caller passes anything: a row object, a single field, an unknown JSON
 * payload. The walker doesn't depend on the row's schema — it sanitizes
 * every string in the structure, which is exactly what ClickHouse cares
 * about when parsing the row's JSON form.
 */
export function sanitizeUnknownInPlace(value: unknown): { value: unknown; fixed: number } {
  if (typeof value === "string") {
    // `detectBadJsonStrings` works on JSON-escaped text — feed it the
    // serialized form so any lone UTF-16 surrogate in the JS string is
    // emitted as a `\uXXXX` escape it can spot. Valid surrogate pairs
    // (e.g. emoji) are emitted as raw characters by JSON.stringify and
    // exit at the function's fast path.
    if (detectBadJsonStrings(JSON.stringify(value))) {
      return { value: INVALID_UTF16_SENTINEL, fixed: 1 };
    }
    return { value, fixed: 0 };
  }

  if (typeof value === "number" && isUnsafeJsonInteger(value)) {
    return { value: String(value), fixed: 1 };
  }

  if (Array.isArray(value)) {
    let fixed = 0;
    for (let i = 0; i < value.length; i++) {
      const result = sanitizeUnknownInPlace(value[i]);
      value[i] = result.value;
      fixed += result.fixed;
    }
    return { value, fixed };
  }

  if (value !== null && typeof value === "object") {
    let fixed = 0;
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const result = sanitizeUnknownInPlace(obj[k]);
      obj[k] = result.value;
      fixed += result.fixed;
    }
    return { value, fixed };
  }

  return { value, fixed: 0 };
}

/**
 * Sanitizes every row in `rows`, mutating each in place so callers can
 * hand the same array to the retry insert.
 *
 * Rationale for scanning the whole batch (instead of starting from the
 * row index ClickHouse reports): `at row N` semantics under
 * `input_format_parallel_parsing` aren't well-defined — N can be
 * chunk-relative rather than batch-global, and 0-vs-1 indexing differs
 * between formats. Whole-batch scanning is robust to those quirks and
 * also catches multiple bad rows in one pass (so a single retry covers
 * the entire failure even if more than one row is poisoned).
 *
 * The cost is bounded: this only runs on the rare ClickHouse-rejection
 * path, and `detectBadJsonStrings` exits in O(1) for clean strings
 * (the fast `indexOf("\\u")` check), so healthy attributes are effectively
 * free even when included in the walk.
 */
export function sanitizeRows<T extends object>(rows: T[]): SanitizeResult {
  const result: SanitizeResult = { rowsTouched: 0, fieldsSanitized: 0 };

  for (let i = 0; i < rows.length; i++) {
    const { fixed } = sanitizeUnknownInPlace(rows[i]);
    if (fixed > 0) {
      result.rowsTouched++;
      result.fieldsSanitized += fixed;
    }
  }

  return result;
}

export function errorMessage(err: unknown): string {
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message?: unknown }).message ?? "")
    : String(err);
}

export function rawErrorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const raw = (err as { rawMessage?: unknown }).rawMessage;
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return errorMessage(err);
}

export type JsonParseRecoveryLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

export type JsonParseRecoveryOutcome =
  | { kind: "inserted"; insertResult: unknown }
  | { kind: "sanitized"; insertResult: unknown }
  | { kind: "recovered"; rowsStripped: number; rowsDropped: number; capped: boolean };

/**
 * Default number of poison rows to isolate-and-strip precisely before bailing
 * to a single `allow_errors` skip insert. One covers the common case (a single
 * un-ingestable run in a flush) exactly, keeping that run's status. The bound
 * matters because run-replication flushes are large (thousands of rows in prod)
 * and stripping re-sends the whole batch once per poison row: without a small
 * limit, a burst of un-ingestable runs in one flush would re-parse a large
 * batch many times on the shared ClickHouse server.
 */
export const DEFAULT_MAX_POISON_STRIPS = 1;

/**
 * ClickHouse insert recovery for `Cannot parse JSON object` rejections on the
 * runs table, where the poison run should KEEP its status (its row lands with
 * its JSON column emptied) rather than be dropped.
 *
 *   1. Try the insert. Healthy batches pay zero recovery cost.
 *   2. On a parse error, `sanitizeRows` losslessly repairs what it can in place
 *      (lone UTF-16 surrogates, out-of-range integers) and retries once.
 *   3. If the sanitizer can't help, follow ClickHouse's `at row N` hint to the
 *      un-ingestable row and re-insert with that row's JSON column(s) emptied
 *      via `stripJsonColumns`, up to `maxPoisonStrips` rows. Each stripped run
 *      still lands (keeps its terminal status); only its un-ingestable JSON is
 *      lost. `insertSync` disables parallel parsing so `at row N` is reliable.
 *   4. Cost bound: once `maxPoisonStrips` rows have been stripped and the batch
 *      STILL fails (or the failing row can't be located), stop stripping and
 *      land the batch with one `allow_errors` insert — the stripped rows and
 *      every clean row land in a single pass and the remaining un-ingestable
 *      rows are skipped. Recovery stays a fixed handful of inserts no matter how
 *      large or poisoned the batch is (`capped` marks that the bail was taken).
 *   5. Non-parse errors propagate unchanged.
 */
export async function insertWithLimitedStrip<T extends object>(params: {
  rows: T[];
  contextLabel: string;
  logger: JsonParseRecoveryLogger;
  logContext?: Record<string, unknown>;
  insert: (rows: T[]) => Promise<unknown>;
  insertSync: (rows: T[]) => Promise<unknown>;
  insertAllowingBadRows: (rows: T[]) => Promise<unknown>;
  stripJsonColumns: (row: T) => T;
  maxPoisonStrips?: number;
  hasMaterializedViews?: boolean;
}): Promise<JsonParseRecoveryOutcome> {
  const { rows, contextLabel, logger, logContext, insert, insertSync, insertAllowingBadRows } =
    params;
  const stripJsonColumns = params.stripJsonColumns;
  const maxPoisonStrips = params.maxPoisonStrips ?? DEFAULT_MAX_POISON_STRIPS;
  const hasMaterializedViews = params.hasMaterializedViews ?? true;

  try {
    return { kind: "inserted", insertResult: await insert(rows) };
  } catch (firstError) {
    if (!isClickHouseJsonParseError(firstError)) throw firstError;

    const firstMessage = errorMessage(firstError);
    const { rowsTouched, fieldsSanitized } = sanitizeRows(rows);

    if (fieldsSanitized > 0) {
      logger.warn("Sanitizing batch after ClickHouse JSON parse error", {
        ...logContext,
        contextLabel,
        batchSize: rows.length,
        rowsTouched,
        fieldsSanitized,
        clickhouseError: firstMessage.split("\n")[0],
      });

      try {
        return { kind: "sanitized", insertResult: await insert(rows) };
      } catch (retryError) {
        if (!isClickHouseJsonParseError(retryError)) throw retryError;
      }
    }

    const working = rows.slice();
    const stripped = new Array(working.length).fill(false);
    let rowsStripped = 0;

    let guard = maxPoisonStrips + 2;
    while (guard-- > 0) {
      let parseError: unknown;
      try {
        await insertSync(working);
        if (rowsStripped > 0) {
          logger.info(
            "Stripped un-ingestable rows after ClickHouse JSON parse error — batch landed with their JSON emptied",
            {
              ...logContext,
              contextLabel,
              batchSize: rows.length,
              rowsStripped,
              clickhouseError: firstMessage.split("\n")[0],
            }
          );
        }
        return { kind: "recovered", rowsStripped, rowsDropped: 0, capped: false };
      } catch (error) {
        if (!isClickHouseJsonParseError(error)) throw error;
        parseError = error;
      }

      const hint = parseRowNumberFromError(rawErrorMessage(parseError));
      const index = hint === null ? -1 : hint - 1;
      const canStrip =
        rowsStripped < maxPoisonStrips && index >= 0 && index < working.length && !stripped[index];

      if (!canStrip) break;

      working[index] = stripJsonColumns(working[index]);
      stripped[index] = true;
      rowsStripped += 1;
    }

    const insertResult = await insertAllowingBadRows(working);
    const rowsDropped = droppedRowCount(insertResult, working.length, hasMaterializedViews);

    logger.warn(
      "Hit the poison-row strip limit — landed the batch via allow_errors and skipped the remaining un-ingestable rows",
      {
        ...logContext,
        contextLabel,
        batchSize: rows.length,
        rowsStripped,
        rowsDropped,
        landedRows: writtenRowCount(insertResult),
        clickhouseError: firstMessage.split("\n")[0],
      }
    );

    return { kind: "recovered", rowsStripped, rowsDropped, capped: true };
  }
}

function writtenRowCount(insertResult: unknown): number | null {
  if (typeof insertResult === "object" && insertResult !== null) {
    const summary = (insertResult as { summary?: { written_rows?: unknown } }).summary;
    const written = summary?.written_rows;
    if (typeof written === "number" && Number.isFinite(written)) return written;
    if (typeof written === "string" && written.length > 0) {
      const parsed = Number.parseInt(written, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Derives how many rows a `allow_errors` insert dropped, from the insert
 * summary's `written_rows`. This is exact only when `written_rows` is a clean
 * count of the target-table rows. On tables with row-multiplying materialized
 * views, ClickHouse folds the MV-written rows into `written_rows` too, so a
 * partial-drop count isn't derivable; the only reliable signal there is
 * `written_rows === 0`, which means the whole batch was dropped (no base rows,
 * so no MV rows either).
 */
function droppedRowCount(
  insertResult: unknown,
  batchSize: number,
  hasMaterializedViews: boolean
): number {
  const written = writtenRowCount(insertResult);
  if (written === null) return 0;
  if (written === 0) return batchSize;
  if (hasMaterializedViews) return 0;
  return Math.max(0, batchSize - written);
}

/**
 * Shared ClickHouse insert recovery that SKIPS un-ingestable rows, for the
 * high-volume append-only tables (trace events, run payloads) where dropping a
 * single un-ingestable row is acceptable and precise row isolation isn't worth
 * its re-parse cost on the shared ClickHouse server.
 *
 *   1. Try the insert. Healthy batches pay zero recovery cost.
 *   2. On a parse error, `sanitizeRows` losslessly repairs what it can in place
 *      and retries once, so a repairable row still lands in full.
 *   3. If the sanitizer can't help, re-insert once with ClickHouse's
 *      `input_format_allow_errors_*` so the good rows land in a single pass and
 *      only the un-ingestable rows are skipped. A poison flood costs one extra
 *      insert regardless of how many rows are bad.
 *   4. Non-parse errors propagate unchanged.
 *
 * The batch-level recovery is always counted by the caller; the per-row dropped
 * count is exact on tables without row-multiplying materialized views and
 * whole-batch-only on tables that have them (see `droppedRowCount`).
 */
export async function insertWithBadRowSkip<T extends object>(params: {
  rows: T[];
  contextLabel: string;
  logger: JsonParseRecoveryLogger;
  logContext?: Record<string, unknown>;
  insert: (rows: T[]) => Promise<unknown>;
  insertAllowingBadRows: (rows: T[]) => Promise<unknown>;
  hasMaterializedViews?: boolean;
}): Promise<JsonParseRecoveryOutcome> {
  const { rows, contextLabel, logger, logContext, insert, insertAllowingBadRows } = params;
  const hasMaterializedViews = params.hasMaterializedViews ?? true;

  try {
    return { kind: "inserted", insertResult: await insert(rows) };
  } catch (firstError) {
    if (!isClickHouseJsonParseError(firstError)) throw firstError;

    const firstMessage = errorMessage(firstError);
    const { rowsTouched, fieldsSanitized } = sanitizeRows(rows);

    if (fieldsSanitized > 0) {
      logger.warn("Sanitizing batch after ClickHouse JSON parse error", {
        ...logContext,
        contextLabel,
        batchSize: rows.length,
        rowsTouched,
        fieldsSanitized,
        clickhouseError: firstMessage.split("\n")[0],
      });

      try {
        return { kind: "sanitized", insertResult: await insert(rows) };
      } catch (retryError) {
        if (!isClickHouseJsonParseError(retryError)) throw retryError;
      }
    }

    const insertResult = await insertAllowingBadRows(rows);
    const rowsDropped = droppedRowCount(insertResult, rows.length, hasMaterializedViews);

    logger.info(
      "Skipped un-ingestable rows after ClickHouse JSON parse error — landed the rest of the batch",
      {
        ...logContext,
        contextLabel,
        batchSize: rows.length,
        rowsDropped,
        landedRows: writtenRowCount(insertResult),
        clickhouseError: firstMessage.split("\n")[0],
      }
    );

    return { kind: "recovered", rowsStripped: 0, rowsDropped, capped: false };
  }
}
