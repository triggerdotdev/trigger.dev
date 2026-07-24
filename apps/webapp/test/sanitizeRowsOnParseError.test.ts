import { describe, it, expect } from "vitest";
import {
  INVALID_UTF16_SENTINEL,
  insertWithBadRowSkip,
  insertWithLimitedStrip,
  isClickHouseJsonParseError,
  parseRowNumberFromError,
  sanitizeRows,
  sanitizeUnknownInPlace,
} from "~/v3/eventRepository/sanitizeRowsOnParseError.server";

const HIGH_SURROGATE = "\uD800";
const LOW_SURROGATE = "\uDC00";

type FakeRow = {
  id: number;
  poison?: boolean;
  unstrippable?: boolean;
  stripped?: boolean;
  msg?: string;
};

const silentLogger = { info: () => {}, warn: () => {} };

function parseErrorAtRow(oneBasedRow: number) {
  return new Error(
    `Cannot parse JSON object here: {...}: (at row ${oneBasedRow})\n: While executing ParallelParsingBlockInputFormat.`
  );
}

/**
 * Builds insert doubles for `insertWithLimitedStrip`: an insert that fails at
 * the first still-poison row (reporting ClickHouse's 1-based `at row N`), an
 * allow-bad-rows insert that lands only the good rows and reports the landed
 * count in a summary, and a strip that clears the poison marker (but cannot fix
 * an `unstrippable` row).
 */
function makeHarness() {
  const landed: FakeRow[] = [];
  let insertCalls = 0;
  let allowCalls = 0;
  const insertSync = async (rows: FakeRow[]) => {
    insertCalls += 1;
    const badIndex = rows.findIndex((r) => r.poison || r.unstrippable);
    if (badIndex >= 0) throw parseErrorAtRow(badIndex + 1);
    landed.push(...rows);
    return { summary: { written_rows: String(rows.length) } };
  };
  const insertAllowingBadRows = async (rows: FakeRow[]) => {
    allowCalls += 1;
    const good = rows.filter((r) => !(r.poison || r.unstrippable));
    landed.push(...good);
    return { summary: { written_rows: String(good.length) } };
  };
  const stripJsonColumns = (row: FakeRow): FakeRow =>
    row.unstrippable ? row : { ...row, poison: false, stripped: true };
  return {
    landed,
    insertSync,
    insertAllowingBadRows,
    stripJsonColumns,
    insertCalls: () => insertCalls,
    allowCalls: () => allowCalls,
  };
}

describe("isClickHouseJsonParseError", () => {
  it("recognises ClickHouse's parse-error string", () => {
    const err = new Error(
      "Cannot parse JSON object here: {...}: (while reading the value of key attributes): (at row 15)\n: While executing ParallelParsingBlockInputFormat. "
    );
    expect(isClickHouseJsonParseError(err)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isClickHouseJsonParseError(new Error("Connection refused"))).toBe(false);
    expect(
      isClickHouseJsonParseError(
        new Error("Size of JSON object at position 999 is extremely large.")
      )
    ).toBe(false);
  });

  it("returns false for null / undefined / strings", () => {
    expect(isClickHouseJsonParseError(null)).toBe(false);
    expect(isClickHouseJsonParseError(undefined)).toBe(false);
    expect(isClickHouseJsonParseError("Cannot parse JSON object")).toBe(true);
  });
});

describe("parseRowNumberFromError", () => {
  it("extracts the row index from a typical ClickHouse error message", () => {
    expect(
      parseRowNumberFromError(
        "Cannot parse JSON object here: { ... }: (while reading the value of key attributes): (at row 1942)\n: While executing ParallelParsingBlockInputFormat."
      )
    ).toBe(1942);
  });

  it("returns null when no row index is present", () => {
    expect(parseRowNumberFromError("Some other error without a row hint")).toBeNull();
  });

  it("returns the first match when multiple `at row N` substrings exist", () => {
    expect(parseRowNumberFromError("at row 1, oops also at row 2")).toBe(1);
  });
});

describe("sanitizeUnknownInPlace", () => {
  it("returns the string unchanged when it has no surrogates", () => {
    const result = sanitizeUnknownInPlace("hello world");
    expect(result).toEqual({ value: "hello world", fixed: 0 });
  });

  it("replaces a lone-surrogate string with the sentinel", () => {
    const result = sanitizeUnknownInPlace(`prefix ${HIGH_SURROGATE} suffix`);
    expect(result.value).toBe(INVALID_UTF16_SENTINEL);
    expect(result.fixed).toBe(1);
  });

  it("leaves valid surrogate pairs (emoji) intact", () => {
    const result = sanitizeUnknownInPlace("hello 😀 world");
    expect(result.value).toBe("hello 😀 world");
    expect(result.fixed).toBe(0);
  });

  it("walks nested objects and mutates string leaves in place", () => {
    const row = {
      id: "row-1",
      attributes: {
        ai: {
          prompt: { messages: `bad ${HIGH_SURROGATE} string` },
          usage: { input_tokens: 42 },
        },
        clean: "untouched",
      },
    };
    const result = sanitizeUnknownInPlace(row);
    expect(result.fixed).toBe(1);
    expect((row.attributes.ai.prompt as any).messages).toBe(INVALID_UTF16_SENTINEL);
    expect(row.attributes.clean).toBe("untouched");
    expect((row.attributes.ai.usage as any).input_tokens).toBe(42);
    expect(row.id).toBe("row-1");
  });

  it("walks arrays recursively", () => {
    const value = [
      "ok",
      `bad ${LOW_SURROGATE} value`,
      "also ok",
      { nested: `also bad ${HIGH_SURROGATE}` },
    ];
    const result = sanitizeUnknownInPlace(value);
    expect(result.fixed).toBe(2);
    expect(value[1]).toBe(INVALID_UTF16_SENTINEL);
    expect((value[3] as any).nested).toBe(INVALID_UTF16_SENTINEL);
    expect(value[0]).toBe("ok");
    expect(value[2]).toBe("also ok");
  });

  it("leaves non-string primitives untouched", () => {
    expect(sanitizeUnknownInPlace(42)).toEqual({ value: 42, fixed: 0 });
    expect(sanitizeUnknownInPlace(true)).toEqual({ value: true, fixed: 0 });
    expect(sanitizeUnknownInPlace(null)).toEqual({ value: null, fixed: 0 });
    expect(sanitizeUnknownInPlace(undefined)).toEqual({ value: undefined, fixed: 0 });
  });

  // ─── Out-of-range integers (TRI-9755) ──────────────────────────────────────
  // ClickHouse's JSON(max_dynamic_paths) column rejects bare integer tokens
  // outside [Int64.MIN, UInt64.MAX]. Such Numbers serialise as bare integer
  // form via JSON.stringify (no exponent, since |value| < 1e21) so they reach
  // ClickHouse as unquoted oversized ints. Sanitizer replaces them with the
  // string form, which ClickHouse's dynamic JSON column accepts as a String
  // subtype on that path.

  it("replaces an integer-valued Number above UInt64.MAX with its string form", () => {
    // 117039831458782870000 is the actual prod value (Google Plus ID after
    // upstream JS-Number precision loss from 117039831458782873093).
    const result = sanitizeUnknownInPlace(117039831458782870000);
    expect(result.value).toBe("117039831458782870000");
    expect(result.fixed).toBe(1);
  });

  it("catches the float64 boundary at exactly 2**64 (UInt64.MAX + 1)", () => {
    // float64 cannot represent UInt64.MAX (2^64 - 1) exactly — the literal
    // 18446744073709551615 in JS source rounds to 2^64. JSON.stringify
    // emits this Number as "18446744073709552000", which exceeds UInt64.MAX
    // and trips ClickHouse. Regression for the BigInt-based comparison;
    // a naïve `value > 18446744073709551615` would let this pass.
    const result = sanitizeUnknownInPlace(2 ** 64);
    expect(result.value).toBe("18446744073709552000");
    expect(result.fixed).toBe(1);
  });

  it("replaces an integer-valued Number below Int64.MIN with its string form", () => {
    // -9223372036854775809 is the first failing negative; in float64 it
    // rounds to the same representation as Int64.MIN (-9223372036854775808),
    // but for completeness we check a clearly-out-of-range negative.
    const result = sanitizeUnknownInPlace(-1e20);
    expect(result.value).toBe("-100000000000000000000");
    expect(result.fixed).toBe(1);
  });

  it("leaves safe integers and boundary values untouched", () => {
    // 42 — safe integer
    expect(sanitizeUnknownInPlace(42)).toEqual({ value: 42, fixed: 0 });
    // Number.MAX_SAFE_INTEGER (2^53 - 1) — JSON.stringify still emits as integer
    expect(sanitizeUnknownInPlace(Number.MAX_SAFE_INTEGER)).toEqual({
      value: Number.MAX_SAFE_INTEGER,
      fixed: 0,
    });
    // 2^63 (Int64.MAX + 1) — still fits in UInt64, CH accepts it
    expect(sanitizeUnknownInPlace(2 ** 63)).toEqual({ value: 2 ** 63, fixed: 0 });
  });

  it("leaves non-integer numbers untouched (floats, NaN, Infinity)", () => {
    // Numbers with a fractional part — emitted with `.` in JSON
    expect(sanitizeUnknownInPlace(3.14)).toEqual({ value: 3.14, fixed: 0 });
    // Very large float-form (>= 1e21) — JSON.stringify uses exponent form,
    // CH parses as Float64 successfully
    expect(sanitizeUnknownInPlace(1e25)).toEqual({ value: 1e25, fixed: 0 });
    // NaN / Infinity — JSON.stringify emits `null`, so harmless on the wire
    expect(sanitizeUnknownInPlace(Number.NaN)).toEqual({ value: Number.NaN, fixed: 0 });
    expect(sanitizeUnknownInPlace(Number.POSITIVE_INFINITY)).toEqual({
      value: Number.POSITIVE_INFINITY,
      fixed: 0,
    });
  });

  it("finds an oversized integer nested deep inside the actual scan-social-profiles shape", () => {
    const row = {
      output: {
        data: {
          profiles: [
            { module: "linktree", query: "x@example.com" },
            {
              module: "poshmark",
              spec_format: [
                {
                  platform_variables: [
                    {
                      key: "gp_id",
                      proper_key: "Gp Id",
                      // The actual prod value — bare JSON integer > UInt64.MAX
                      value: 117039831458782870000,
                      type: "int",
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    const result = sanitizeUnknownInPlace(row);
    expect(result.fixed).toBe(1);
    expect((row.output.data.profiles[1].spec_format![0].platform_variables[0] as any).value).toBe(
      "117039831458782870000"
    );
    // Untouched neighbours
    expect(row.output.data.profiles[0].module).toBe("linktree");
    expect(row.output.data.profiles[1].spec_format![0].platform_variables[0].type).toBe("int");
  });
});

describe("sanitizeRows", () => {
  function makeRow(suffix: string, badField?: string) {
    return {
      id: `row-${suffix}`,
      attributes: { foo: badField ?? "clean" },
    };
  }

  it("sanitizes every row that has bad strings", () => {
    const rows = [
      makeRow("0", `bad-0-${HIGH_SURROGATE}`),
      makeRow("1", `bad-1-${HIGH_SURROGATE}`),
      makeRow("2", "clean"),
      makeRow("3", `bad-3-${HIGH_SURROGATE}`),
    ];

    const result = sanitizeRows(rows);

    expect(rows[0].attributes.foo).toBe(INVALID_UTF16_SENTINEL);
    expect(rows[1].attributes.foo).toBe(INVALID_UTF16_SENTINEL);
    expect(rows[2].attributes.foo).toBe("clean");
    expect(rows[3].attributes.foo).toBe(INVALID_UTF16_SENTINEL);
    expect(result.rowsTouched).toBe(3);
    expect(result.fieldsSanitized).toBe(3);
  });

  it("returns zero counts when no row has bad strings", () => {
    const rows = [makeRow("0"), makeRow("1"), makeRow("2")];
    const result = sanitizeRows(rows);
    expect(result).toEqual({ rowsTouched: 0, fieldsSanitized: 0 });
  });

  it("returns zero counts for an empty batch", () => {
    expect(sanitizeRows([])).toEqual({ rowsTouched: 0, fieldsSanitized: 0 });
  });

  it("counts multiple sanitized fields on the same row as one rowTouched but multiple fields", () => {
    const rows = [
      {
        id: "r0",
        attributes: {
          a: `bad ${HIGH_SURROGATE}`,
          b: `also bad ${LOW_SURROGATE}`,
          c: "fine",
        },
      },
    ];
    const result = sanitizeRows(rows);
    expect(result.rowsTouched).toBe(1);
    expect(result.fieldsSanitized).toBe(2);
  });

  it("counts surrogate fixes and out-of-range integer fixes together (TRI-9755)", () => {
    const rows = [
      {
        id: "r0",
        attributes: {
          surrogate: `bad ${HIGH_SURROGATE}`,
          bigint: 117039831458782870000,
          clean: "fine",
          safe: 42,
        },
      },
      {
        id: "r1",
        attributes: {
          bigint: -1e20,
          clean: "still fine",
        },
      },
      {
        id: "r2",
        attributes: { clean: "no fixes needed" },
      },
    ];
    const result = sanitizeRows(rows);
    expect(result.rowsTouched).toBe(2);
    expect(result.fieldsSanitized).toBe(3);
    expect(rows[0].attributes.surrogate).toBe(INVALID_UTF16_SENTINEL);
    expect(rows[0].attributes.bigint).toBe("117039831458782870000");
    expect(rows[0].attributes.safe).toBe(42);
    expect(rows[1].attributes.bigint).toBe("-100000000000000000000");
  });
});

describe("insertWithLimitedStrip", () => {
  const clean = (id: number): FakeRow => ({ id });

  it("inserts a healthy batch with no recovery", async () => {
    const { landed, insertSync, insertAllowingBadRows, stripJsonColumns, allowCalls } =
      makeHarness();
    const rows = [clean(0), clean(1), clean(2)];

    const outcome = await insertWithLimitedStrip({
      rows,
      contextLabel: "test",
      logger: silentLogger,
      insert: insertSync,
      insertSync,
      insertAllowingBadRows,
      stripJsonColumns,
    });

    expect(outcome.kind).toBe("inserted");
    expect(landed).toHaveLength(3);
    expect(allowCalls()).toBe(0);
  });

  it("strips a single poison row and lands the rest in full without bailing", async () => {
    const { landed, insertSync, insertAllowingBadRows, stripJsonColumns, allowCalls } =
      makeHarness();
    const rows = [clean(0), clean(1), { id: 2, poison: true }, clean(3), clean(4)];

    const outcome = await insertWithLimitedStrip({
      rows,
      contextLabel: "test",
      logger: silentLogger,
      insert: insertSync,
      insertSync,
      insertAllowingBadRows,
      stripJsonColumns,
    });

    expect(outcome).toEqual({ kind: "recovered", rowsStripped: 1, rowsDropped: 0, capped: false });
    expect(landed.map((r) => r.id).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(landed.find((r) => r.id === 2)?.stripped).toBe(true);
    expect(landed.filter((r) => r.id !== 2).every((r) => !r.stripped)).toBe(true);
    expect(allowCalls()).toBe(0);
  });

  it("strips up to the limit, then bails to allow_errors and skips the excess poison", async () => {
    const { landed, insertSync, insertAllowingBadRows, stripJsonColumns, allowCalls } =
      makeHarness();
    const rows = [clean(0), { id: 1, poison: true }, clean(2), { id: 3, poison: true }, clean(4)];

    const outcome = await insertWithLimitedStrip({
      rows,
      contextLabel: "test",
      logger: silentLogger,
      insert: insertSync,
      insertSync,
      insertAllowingBadRows,
      stripJsonColumns,
      maxPoisonStrips: 1,
      hasMaterializedViews: false,
    });

    expect(outcome).toEqual({ kind: "recovered", rowsStripped: 1, rowsDropped: 1, capped: true });
    expect(allowCalls()).toBe(1);
    expect(landed.map((r) => r.id).sort((a, b) => a - b)).toEqual([0, 1, 2, 4]);
    expect(landed.find((r) => r.id === 1)?.stripped).toBe(true);
    expect(landed.some((r) => r.id === 3)).toBe(false);
  });

  it("strips every poison row when the limit is high enough", async () => {
    const { landed, insertSync, insertAllowingBadRows, stripJsonColumns, allowCalls } =
      makeHarness();
    const rows = [clean(0), { id: 1, poison: true }, { id: 2, poison: true }, clean(3)];

    const outcome = await insertWithLimitedStrip({
      rows,
      contextLabel: "test",
      logger: silentLogger,
      insert: insertSync,
      insertSync,
      insertAllowingBadRows,
      stripJsonColumns,
      maxPoisonStrips: 3,
    });

    expect(outcome).toEqual({ kind: "recovered", rowsStripped: 2, rowsDropped: 0, capped: false });
    expect(allowCalls()).toBe(0);
    expect(landed.map((r) => r.id).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("bails to allow_errors when the failing row cannot be located", async () => {
    const landed: FakeRow[] = [];
    let allowCalls = 0;
    const insertSync = async (rows: FakeRow[]) => {
      if (rows.some((r) => r.poison)) {
        throw new Error("Cannot parse JSON object here: {...} (no row hint here)");
      }
      landed.push(...rows);
      return { summary: { written_rows: String(rows.length) } };
    };
    const insertAllowingBadRows = async (rows: FakeRow[]) => {
      allowCalls += 1;
      const good = rows.filter((r) => !r.poison);
      landed.push(...good);
      return { summary: { written_rows: String(good.length) } };
    };

    const outcome = await insertWithLimitedStrip({
      rows: [clean(0), { id: 1, poison: true }, clean(2)],
      contextLabel: "test",
      logger: silentLogger,
      insert: insertSync,
      insertSync,
      insertAllowingBadRows,
      stripJsonColumns: (row) => row,
      hasMaterializedViews: false,
    });

    expect(outcome).toEqual({ kind: "recovered", rowsStripped: 0, rowsDropped: 1, capped: true });
    expect(allowCalls).toBe(1);
    expect(landed.map((r) => r.id).sort((a, b) => a - b)).toEqual([0, 2]);
  });

  it("rethrows non-parse errors so the caller's transient-retry path handles them", async () => {
    const insert = async () => {
      throw new Error("Connection refused");
    };

    await expect(
      insertWithLimitedStrip({
        rows: [clean(0)],
        contextLabel: "test",
        logger: silentLogger,
        insert,
        insertSync: insert,
        insertAllowingBadRows: insert,
        stripJsonColumns: (row) => row,
      })
    ).rejects.toThrow("Connection refused");
  });
});

/**
 * Builds insert doubles for `insertWithBadRowSkip`: a normal insert that fails
 * whole when any row is poison, plus an allow-bad-rows insert that lands only
 * the good rows and reports the landed count in a ClickHouse-style summary
 * (`written_rows`) so the recovery can derive how many rows were skipped.
 */
function makeSkipHarness() {
  const landed: FakeRow[] = [];
  let insertCalls = 0;
  let allowCalls = 0;
  const insert = async (rows: FakeRow[]) => {
    insertCalls += 1;
    const badIndex = rows.findIndex((r) => r.poison || r.unstrippable);
    if (badIndex >= 0) throw parseErrorAtRow(badIndex + 1);
    landed.push(...rows);
    return { summary: { written_rows: String(rows.length) } };
  };
  const insertAllowingBadRows = async (rows: FakeRow[]) => {
    allowCalls += 1;
    const good = rows.filter((r) => !(r.poison || r.unstrippable));
    landed.push(...good);
    return { summary: { written_rows: String(good.length) } };
  };
  return {
    landed,
    insert,
    insertAllowingBadRows,
    insertCalls: () => insertCalls,
    allowCalls: () => allowCalls,
  };
}

describe("insertWithBadRowSkip", () => {
  const clean = (id: number): FakeRow => ({ id });

  it("inserts a healthy batch with no recovery", async () => {
    const { landed, insert, insertAllowingBadRows, allowCalls } = makeSkipHarness();

    const outcome = await insertWithBadRowSkip({
      rows: [clean(0), clean(1), clean(2)],
      contextLabel: "test",
      logger: silentLogger,
      insert,
      insertAllowingBadRows,
    });

    expect(outcome.kind).toBe("inserted");
    expect(landed).toHaveLength(3);
    expect(allowCalls()).toBe(0);
  });

  it("skips the poison rows in one extra insert and counts drops exactly on a table with no materialized views", async () => {
    const { landed, insert, insertAllowingBadRows, insertCalls, allowCalls } = makeSkipHarness();
    const rows = [clean(0), { id: 1, poison: true }, clean(2), { id: 3, poison: true }, clean(4)];

    const outcome = await insertWithBadRowSkip({
      rows,
      contextLabel: "test",
      logger: silentLogger,
      insert,
      insertAllowingBadRows,
      hasMaterializedViews: false,
    });

    expect(outcome).toEqual({ kind: "recovered", rowsStripped: 0, rowsDropped: 2, capped: false });
    expect(landed.map((r) => r.id).sort((a, b) => a - b)).toEqual([0, 2, 4]);
    expect(insertCalls()).toBe(1);
    expect(allowCalls()).toBe(1);
  });

  it("counts only whole-batch drops on a table with materialized views (partial drop uncountable)", async () => {
    const inflatedSummary = (goodCount: number) => ({
      summary: { written_rows: String(goodCount * 3) },
    });
    const insert = async (rows: FakeRow[]) => {
      if (rows.some((r) => r.poison)) throw parseErrorAtRow(1);
      return inflatedSummary(rows.length);
    };
    const insertAllowingBadRows = async (rows: FakeRow[]) =>
      inflatedSummary(rows.filter((r) => !r.poison).length);

    const partial = await insertWithBadRowSkip({
      rows: [clean(0), { id: 1, poison: true }, clean(2)],
      contextLabel: "test",
      logger: silentLogger,
      insert,
      insertAllowingBadRows,
      hasMaterializedViews: true,
    });
    expect(partial).toEqual({ kind: "recovered", rowsStripped: 0, rowsDropped: 0, capped: false });

    const wholeBatch = await insertWithBadRowSkip({
      rows: [
        { id: 0, poison: true },
        { id: 1, poison: true },
      ],
      contextLabel: "test",
      logger: silentLogger,
      insert,
      insertAllowingBadRows,
      hasMaterializedViews: true,
    });
    expect(wholeBatch).toEqual({
      kind: "recovered",
      rowsStripped: 0,
      rowsDropped: 2,
      capped: false,
    });
  });

  it("sanitizes a repairable batch and lands it in full without skipping any row", async () => {
    const landed: FakeRow[] = [];
    let allowCalls = 0;
    const insert = async (rows: FakeRow[]) => {
      if (rows.some((r) => typeof r.msg === "string" && r.msg.includes(HIGH_SURROGATE))) {
        throw parseErrorAtRow(1);
      }
      landed.push(...rows);
      return { summary: { written_rows: String(rows.length) } };
    };
    const insertAllowingBadRows = async (rows: FakeRow[]) => {
      allowCalls += 1;
      landed.push(...rows);
      return { summary: { written_rows: String(rows.length) } };
    };
    const rows: FakeRow[] = [
      { id: 0, msg: `bad ${HIGH_SURROGATE}` },
      { id: 1, msg: "clean" },
    ];

    const outcome = await insertWithBadRowSkip({
      rows,
      contextLabel: "test",
      logger: silentLogger,
      insert,
      insertAllowingBadRows,
    });

    expect(outcome.kind).toBe("sanitized");
    expect(allowCalls).toBe(0);
    expect(landed).toHaveLength(2);
    expect(rows[0].msg).toBe(INVALID_UTF16_SENTINEL);
  });

  it("reports zero dropped when the summary has no written_rows count", async () => {
    const insert = async (rows: FakeRow[]) => {
      if (rows.some((r) => r.poison)) throw parseErrorAtRow(1);
      return undefined;
    };
    const insertAllowingBadRows = async () => ({ summary: {} });

    const outcome = await insertWithBadRowSkip({
      rows: [{ id: 0, poison: true }, clean(1)],
      contextLabel: "test",
      logger: silentLogger,
      insert,
      insertAllowingBadRows,
    });

    expect(outcome).toEqual({ kind: "recovered", rowsStripped: 0, rowsDropped: 0, capped: false });
  });

  it("rethrows non-parse errors so the caller's transient-retry path handles them", async () => {
    const insert = async () => {
      throw new Error("Connection refused");
    };

    await expect(
      insertWithBadRowSkip({
        rows: [clean(0)],
        contextLabel: "test",
        logger: silentLogger,
        insert,
        insertAllowingBadRows: insert,
      })
    ).rejects.toThrow("Connection refused");
  });
});
