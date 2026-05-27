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
