import { useCallback, useMemo, useState } from "react";

export type SortDirection = "asc" | "desc";

type SortState<K extends string = string> = {
  key: K;
  direction: SortDirection;
};

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

/** Presentational props to spread onto a `<TableHeaderCell>` for a given column. */
type TableSortHeaderProps = {
  sortDirection: SortDirection | null;
  onSort: () => void;
};

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

/**
 * Client-side, header-click column sorting for tables of any row shape.
 *
 * Clicking a column cycles asc -> desc -> cleared (back to the original row order), so the
 * incoming order (e.g. a server default) is always reachable without a reload. Returns the
 * sorted rows plus a `getSortProps(key)` helper whose result spreads straight onto
 * `<TableHeaderCell>`.
 */
function useTableSort<T, K extends string = string>(
  rows: T[],
  columns: ReadonlyArray<SortColumn<T, K>>
) {
  const [sort, setSort] = useState<SortState<K> | null>(null);

  const columnsByKey = useMemo(() => {
    const map = new Map<K, SortColumn<T, K>>();
    for (const column of columns) {
      map.set(column.key, column);
    }
    return map;
  }, [columns]);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const column = columnsByKey.get(sort.key);
    if (!column) return rows;
    return sortRows(rows, column, sort.direction);
  }, [rows, sort, columnsByKey]);

  const getSortProps = useCallback(
    (key: K): TableSortHeaderProps => ({
      sortDirection: sort?.key === key ? sort.direction : null,
      onSort: () =>
        setSort((current) => {
          if (!current || current.key !== key) return { key, direction: "asc" };
          if (current.direction === "asc") return { key, direction: "desc" };
          return null;
        }),
    }),
    [sort]
  );

  return { sortedRows, getSortProps, sort };
}
