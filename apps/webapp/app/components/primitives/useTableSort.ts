export type SortDirection = "asc" | "desc";

/**
 * A sortable column definition for {@link useTableSort}.
 *
 * - `"number"`: sorts numerically. `null`/`undefined`/`NaN` values always sort last,
 *   regardless of the sort direction.
 * - `"alpha"`: sorts with `localeCompare`, case-insensitively. Empty/nullish values sort last.
 * - `"custom"`: sorts with the provided comparator `(a, b) => number` (asc order); the direction
 *   flip is applied on top for you.
 *
 * In every case the sort is stable: rows that compare equal keep their original relative order,
 * and with no active sort the rows are returned untouched.
 */
export type SortColumn<T, K extends string = string> =
  | { key: K; type: "number"; value: (row: T) => number | null | undefined }
  | { key: K; type: "alpha"; value: (row: T) => string | null | undefined }
  | { key: K; type: "custom"; compare: (a: T, b: T) => number };

export function compareColumn<T, K extends string>(
  column: SortColumn<T, K>,
  a: T,
  b: T,
  direction: SortDirection
): number {
  const sign = direction === "asc" ? 1 : -1;

  if (column.type === "custom") {
    return sign * column.compare(a, b);
  }

  if (column.type === "number") {
    const av = column.value(a);
    const bv = column.value(b);
    const aNull = av === null || av === undefined || Number.isNaN(av);
    const bNull = bv === null || bv === undefined || Number.isNaN(bv);
    // Nulls always sort last, independent of direction.
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    return sign * (av - bv);
  }

  // alpha
  const av = column.value(a);
  const bv = column.value(b);
  const aEmpty = av === null || av === undefined || av === "";
  const bEmpty = bv === null || bv === undefined || bv === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  return sign * av.localeCompare(bv, undefined, { sensitivity: "base" });
}

/**
 * Stable sort of `rows` by a single `column`/`direction`. Rows that compare equal keep their
 * original relative order. Pure and side-effect free — exported so the sort behavior can be
 * unit-tested without rendering a component.
 */
export function sortRows<T, K extends string>(
  rows: ReadonlyArray<T>,
  column: SortColumn<T, K>,
  direction: SortDirection
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const result = compareColumn(column, a.row, b.row, direction);
      return result !== 0 ? result : a.index - b.index;
    })
    .map((entry) => entry.row);
}
