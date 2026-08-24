/**
 * Removes Unicode NUL (U+0000) from a string. Postgres cannot store a NUL in a
 * `text` column (SQLSTATE 22021) and rejects a `\u0000` escape when a JSON value
 * is stored as `jsonb` (SQLSTATE 22P05), so a caller-supplied NUL reaching
 * `taskRun.create()` fails the insert. The `indexOf` guard keeps the common
 * (NUL-free) case allocation-free on the trigger hot path.
 */
export function removeNullBytes<T extends string | undefined | null>(value: T): T {
  if (typeof value !== "string" || value.indexOf("\u0000") === -1) {
    return value;
  }
  return value.replace(/\u0000/g, "") as T;
}

/**
 * Returns `value` with a NUL-stripped `key`, reusing the original object when no
 * NUL is present. Used for the user-supplied idempotency-key and debounce
 * options, whose `key` lands in a `jsonb` column on the TaskRun row.
 */
export function removeNullBytesFromKey<T extends { key: string } | undefined>(value: T): T {
  if (!value) {
    return value;
  }
  const cleaned = removeNullBytes(value.key);
  return cleaned === value.key ? value : { ...value, key: cleaned };
}
