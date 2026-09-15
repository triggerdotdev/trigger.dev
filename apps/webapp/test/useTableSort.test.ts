import { describe, expect, it } from "vitest";
import { compareColumn, sortRows, type SortColumn } from "~/components/primitives/useTableSort";

type Row = { id: number; name: string | null; queued: number | null };

const rows: Row[] = [
  { id: 0, name: "banana", queued: 3 },
  { id: 1, name: "Apple", queued: null },
  { id: 2, name: "cherry", queued: 3 },
  { id: 3, name: null, queued: 1 },
];

describe("sortRows", () => {
  it("sorts numbers ascending with nulls last", () => {
    const column: SortColumn<Row> = { key: "queued", type: "number", value: (r) => r.queued };
    expect(sortRows(rows, column, "asc").map((r) => r.id)).toEqual([3, 0, 2, 1]);
  });

  it("keeps nulls last even when descending", () => {
    const column: SortColumn<Row> = { key: "queued", type: "number", value: (r) => r.queued };
    // 3 and 0 both have queued=3; stable order (0 before 2) is preserved, null (id 1) stays last.
    expect(sortRows(rows, column, "desc").map((r) => r.id)).toEqual([0, 2, 3, 1]);
  });

  it("sorts alphabetically case-insensitively with empty/null last", () => {
    const column: SortColumn<Row> = { key: "name", type: "alpha", value: (r) => r.name };
    expect(sortRows(rows, column, "asc").map((r) => r.id)).toEqual([1, 0, 2, 3]);
    expect(sortRows(rows, column, "desc").map((r) => r.id)).toEqual([2, 0, 1, 3]);
  });

  it("is stable for equal values (preserves original order)", () => {
    const column: SortColumn<Row> = { key: "queued", type: "number", value: () => 5 };
    expect(sortRows(rows, column, "asc").map((r) => r.id)).toEqual([0, 1, 2, 3]);
  });

  it("supports a custom comparator", () => {
    // Sort by name length.
    const column: SortColumn<Row> = {
      key: "name",
      type: "custom",
      compare: (a, b) => (a.name?.length ?? 0) - (b.name?.length ?? 0),
    };
    expect(sortRows(rows, column, "asc").map((r) => r.id)).toEqual([3, 1, 0, 2]);
  });
});

describe("compareColumn", () => {
  it("treats NaN as null (sorts last)", () => {
    const column: SortColumn<Row> = { key: "queued", type: "number", value: (r) => r.queued };
    const withNaN: Row = { id: 9, name: "x", queued: NaN };
    const normal: Row = { id: 10, name: "y", queued: 1 };
    expect(compareColumn(column, withNaN, normal, "asc")).toBe(1);
    expect(compareColumn(column, withNaN, normal, "desc")).toBe(1);
  });
});
