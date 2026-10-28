// Unit test: the selection URL format is a stable contract that shared links depend on.
import { describe, expect, it } from "vitest";
import type { SessionTreeRow } from "~/components/sessions/v1/trace/buildSessionTree";
import {
  isSameSelection,
  parseSessionTraceSelection,
  rowSelection,
  selectionNodeId,
  selectionSearchValues,
  type SessionTraceSelection,
} from "~/components/sessions/v1/trace/sessionTraceSelection";

const parse = (search: string) => parseSessionTraceSelection(new URLSearchParams(search));

describe("parseSessionTraceSelection", () => {
  it("reads a run and a span", () => {
    expect(parse("?run=run_abc123&span=f00d")).toEqual({
      kind: "span",
      runFriendlyId: "run_abc123",
      spanId: "f00d",
    });
    expect(parse("?run=run_abc123")).toEqual({ kind: "run", runFriendlyId: "run_abc123" });
  });

  it("falls back to the session without a valid run", () => {
    expect(parse("")).toEqual({ kind: "session" });
    expect(parse("?span=f00d")).toEqual({ kind: "session" });
    expect(parse("?run=not-a-run&span=f00d")).toEqual({ kind: "session" });
    expect(parse("?run=")).toEqual({ kind: "session" });
  });

  it("falls back to the run for a malformed span", () => {
    expect(parse("?run=run_abc123&span=a%20b")).toEqual({
      kind: "run",
      runFriendlyId: "run_abc123",
    });
  });
});

describe("selectionSearchValues", () => {
  it("round-trips through the URL", () => {
    const selections: SessionTraceSelection[] = [
      { kind: "session" },
      { kind: "run", runFriendlyId: "run_abc123" },
      { kind: "span", runFriendlyId: "run_abc123", spanId: "f00d" },
    ];
    for (const selection of selections) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(selectionSearchValues(selection))) {
        if (value !== undefined) params.set(key, value);
      }
      expect(parseSessionTraceSelection(params)).toEqual(selection);
    }
  });

  it("clears the span when only a run is selected", () => {
    expect(selectionSearchValues({ kind: "run", runFriendlyId: "run_abc123" })).toEqual({
      run: "run_abc123",
      span: undefined,
    });
  });
});

describe("isSameSelection", () => {
  it("compares kind, run and span", () => {
    const run = { kind: "run", runFriendlyId: "run_a" } as const;
    const span = { kind: "span", runFriendlyId: "run_a", spanId: "s1" } as const;
    expect(isSameSelection({ kind: "session" }, { kind: "session" })).toBe(true);
    expect(isSameSelection(run, { ...run })).toBe(true);
    expect(isSameSelection(run, { kind: "run", runFriendlyId: "run_b" })).toBe(false);
    expect(isSameSelection(run, span)).toBe(false);
    expect(isSameSelection(span, { ...span, spanId: "s2" })).toBe(false);
  });
});

describe("selection and tree rows", () => {
  it("maps a selection to its node and a row back to its selection", () => {
    const rows: SessionTreeRow<unknown>[] = [
      { kind: "session", runCount: 2 },
      {
        kind: "run",
        spansLoaded: false,
        run: {
          number: 1,
          friendlyId: "run_a",
          reason: "initial",
          afterCrash: false,
          status: "EXECUTING",
          createdAt: null,
          startedAt: null,
          finishedAt: null,
        },
      },
      { kind: "span", runFriendlyId: "run_a", spanId: "s1", span: {} },
    ];
    const ids = rows.map((row) => selectionNodeId(rowSelection(row)!));
    expect(ids).toEqual(["session", "run:run_a", "run_a:s1"]);
  });

  it("gives label rows no selection", () => {
    expect(rowSelection({ kind: "gap", durationMs: 1 })).toBeUndefined();
    expect(rowSelection({ kind: "loadEarlier", count: 3 })).toBeUndefined();
    expect(
      rowSelection({
        kind: "notLoaded",
        count: 2,
        olderRunFriendlyId: "run_a",
        newerRunFriendlyId: "run_b",
      })
    ).toBeUndefined();
  });
});
