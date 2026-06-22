import { describe, expect, it } from "vitest";
import {
  decodeCompositeOffset,
  decodeCompositePart,
  encodeComposite,
  mergeParsedShapes,
  parseShapeMessages,
  unpolledShape,
  type ParsedShape,
  type PriorContinuation,
} from "~/services/realtime/electricShapeMerge.server";

const INSERT = {
  key: '"public"."TaskRun"/"r1"',
  value: { id: "r1" },
  headers: { operation: "insert" },
};
const UPDATE = {
  key: '"public"."task_run_v2"/"r2"',
  value: { id: "r2" },
  headers: { operation: "update" },
};

function shape(overrides: Partial<ParsedShape> = {}): ParsedShape {
  return {
    status: 200,
    handle: "h",
    offset: "o",
    cursor: "c",
    schema: '{"id":{"type":"text"}}',
    changes: [],
    upToDate: true,
    mustRefetch: false,
    ...overrides,
  };
}

const PRIOR: PriorContinuation = {
  handleA: "HA",
  offsetA: "OA",
  cursorA: "CA",
  handleB: "HB",
  offsetB: "OB",
  cursorB: "CB",
};

describe("decodeCompositePart", () => {
  it("returns both undefined for null / no separator", () => {
    expect(decodeCompositePart(null)).toEqual({ a: undefined, b: undefined });
    expect(decodeCompositePart(undefined)).toEqual({ a: undefined, b: undefined });
    expect(decodeCompositePart("")).toEqual({ a: undefined, b: undefined });
    // A bare value with no separator means "not a composite yet" -> initial.
    expect(decodeCompositePart("solo")).toEqual({ a: undefined, b: undefined });
  });

  it("splits a composite into its two parts", () => {
    expect(decodeCompositePart("hA~hB")).toEqual({ a: "hA", b: "hB" });
  });

  it("treats an empty side as undefined", () => {
    expect(decodeCompositePart("hA~")).toEqual({ a: "hA", b: undefined });
    expect(decodeCompositePart("~hB")).toEqual({ a: undefined, b: "hB" });
  });
});

describe("decodeCompositeOffset", () => {
  it("applies a bare offset (e.g. the initial -1) to both shapes", () => {
    expect(decodeCompositeOffset("-1")).toEqual({ a: "-1", b: "-1" });
  });

  it("splits a composite offset", () => {
    expect(decodeCompositeOffset("26800552_0~26800999_2")).toEqual({
      a: "26800552_0",
      b: "26800999_2",
    });
  });

  it("round-trips through encodeComposite", () => {
    expect(decodeCompositeOffset(encodeComposite("x_1", "y_2"))).toEqual({ a: "x_1", b: "y_2" });
  });
});

describe("parseShapeMessages", () => {
  const headers = { handle: "h", offset: "o", cursor: "c", schema: "s" };

  it("extracts change rows and the up-to-date flag", () => {
    const body = JSON.stringify([INSERT, { headers: { control: "up-to-date" } }]);
    const parsed = parseShapeMessages(200, headers, body);
    expect(parsed.changes).toEqual([INSERT]);
    expect(parsed.upToDate).toBe(true);
    expect(parsed.mustRefetch).toBe(false);
  });

  it("treats a bare up-to-date as no changes", () => {
    const parsed = parseShapeMessages(
      200,
      headers,
      JSON.stringify([{ headers: { control: "up-to-date" } }])
    );
    expect(parsed.changes).toEqual([]);
    expect(parsed.upToDate).toBe(true);
  });

  it("flags must-refetch from a 409 status", () => {
    const parsed = parseShapeMessages(409, headers, "");
    expect(parsed.mustRefetch).toBe(true);
    expect(parsed.changes).toEqual([]);
  });

  it("flags must-refetch from a control message", () => {
    const body = JSON.stringify([
      { headers: { control: "must-refetch" } },
      { headers: { control: "up-to-date" } },
    ]);
    expect(parseShapeMessages(200, headers, body).mustRefetch).toBe(true);
  });

  it("flags must-refetch for an unparseable / non-array body", () => {
    expect(parseShapeMessages(200, headers, "not json").mustRefetch).toBe(true);
    expect(parseShapeMessages(200, headers, "{}").mustRefetch).toBe(true);
  });

  it("treats an empty body as no changes (not up-to-date)", () => {
    const parsed = parseShapeMessages(200, headers, "");
    expect(parsed.changes).toEqual([]);
    expect(parsed.upToDate).toBe(false);
    expect(parsed.mustRefetch).toBe(false);
  });
});

describe("mergeParsedShapes", () => {
  it("concatenates change rows from both tables", () => {
    const merged = mergeParsedShapes(
      shape({ changes: [INSERT], handle: "hA", offset: "oA", cursor: "cA" }),
      shape({ changes: [UPDATE], handle: "hB", offset: "oB", cursor: "cB" }),
      PRIOR
    );
    expect(merged.mustRefetch).toBe(false);
    if (merged.mustRefetch) return;
    expect(merged.changes).toEqual([INSERT, UPDATE]);
    expect(merged.handle).toBe(encodeComposite("hA", "hB"));
    expect(merged.offset).toBe(encodeComposite("oA", "oB"));
    expect(merged.cursor).toBe(encodeComposite("cA", "cB"));
  });

  it("resets when either shape needs a refetch", () => {
    expect(mergeParsedShapes(shape({ mustRefetch: true }), shape(), PRIOR)).toEqual({
      mustRefetch: true,
    });
    expect(mergeParsedShapes(shape(), shape({ status: 409 }), PRIOR)).toEqual({
      mustRefetch: true,
    });
  });

  it("falls back to the prior continuation for a shape that returned nothing", () => {
    // B was left un-polled (the other table returned changes first).
    const merged = mergeParsedShapes(
      shape({ changes: [INSERT], handle: "hA2", offset: "oA2", cursor: "cA2" }),
      unpolledShape("b", PRIOR),
      PRIOR
    );
    expect(merged.mustRefetch).toBe(false);
    if (merged.mustRefetch) return;
    expect(merged.changes).toEqual([INSERT]);
    expect(merged.handle).toBe(encodeComposite("hA2", "HB"));
    expect(merged.offset).toBe(encodeComposite("oA2", "OB"));
    expect(merged.cursor).toBe(encodeComposite("cA2", "CB"));
  });

  it("uses the prior cursor when a returned shape omits it", () => {
    const merged = mergeParsedShapes(
      shape({ cursor: undefined, handle: "hA", offset: "oA" }),
      shape({ cursor: "cB", handle: "hB", offset: "oB" }),
      PRIOR
    );
    if (merged.mustRefetch) throw new Error("unexpected refetch");
    // a omitted cursor -> prior.cursorA ("CA"); b returned "cB".
    expect(merged.cursor).toBe(encodeComposite("CA", "cB"));
  });

  it("omits the cursor entirely when neither shape nor prior has one (initial snapshot)", () => {
    const initialPrior: PriorContinuation = { offsetA: "-1", offsetB: "-1" };
    const merged = mergeParsedShapes(
      shape({ cursor: undefined, handle: "hA", offset: "oA" }),
      shape({ cursor: undefined, handle: "hB", offset: "oB" }),
      initialPrior
    );
    if (merged.mustRefetch) throw new Error("unexpected refetch");
    expect(merged.cursor).toBeUndefined();
  });

  it("carries schema from whichever shape supplied it", () => {
    const merged = mergeParsedShapes(
      shape({ schema: undefined }),
      shape({ schema: '{"id":{"type":"text"}}' }),
      PRIOR
    );
    if (merged.mustRefetch) throw new Error("unexpected refetch");
    expect(merged.schema).toBe('{"id":{"type":"text"}}');
  });
});
