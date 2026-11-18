import { describe, expect, it } from "vitest";
import {
  anchorAt,
  anchoredScrollTop,
  countNewSpansBelow,
  findIndexNear,
  PILL_UPDATE_MS,
  pillLabel,
  pillUpdateDelayMs,
} from "~/components/sessions/v1/trace/sessionTraceScroll";

const ROW = 32;
const keysOf = (ids: string[]) => (index: number) => ids[index];
const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("scroll anchoring", () => {
  // Catches: live spans landing above the view sliding the rows the user is reading.
  it("keeps the top row in place when rows are added above it", () => {
    const before = rows("r", 100);
    const anchor = anchorAt(40 * ROW + 7, ROW, keysOf(before))!;
    const after = [...before.slice(0, 20), ...rows("new", 12), ...before.slice(20)];
    expect(anchoredScrollTop(anchor, after.length, ROW, keysOf(after))).toBe(52 * ROW + 7);
  });

  // Catches: a collapse above the view jumping the view down by the removed rows.
  it("moves up when rows above are removed", () => {
    const before = rows("r", 100);
    const anchor = anchorAt(40 * ROW, ROW, keysOf(before))!;
    const after = [...before.slice(0, 10), ...before.slice(30)];
    expect(anchoredScrollTop(anchor, after.length, ROW, keysOf(after))).toBe(20 * ROW);
  });

  // Catches: anchoring scrolling when only rows below changed, or after its row disappeared.
  it("leaves the view alone when the top row didn't move or is gone", () => {
    const before = rows("r", 100);
    const anchor = anchorAt(40 * ROW, ROW, keysOf(before))!;
    const grownBelow = [...before, ...rows("new", 50)];
    expect(anchoredScrollTop(anchor, grownBelow.length, ROW, keysOf(grownBelow))).toBeUndefined();
    const withoutTop = before.filter((id) => id !== "r40");
    expect(anchoredScrollTop(anchor, withoutTop.length, ROW, keysOf(withoutTop))).toBeUndefined();
  });

  // Catches: the outward search missing rows on either side of the hint or past the ends.
  it("finds a row searching outwards from where it was", () => {
    const ids = rows("r", 1000);
    expect(findIndexNear("r500", 495, ids.length, keysOf(ids))).toBe(500);
    expect(findIndexNear("r3", 900, ids.length, keysOf(ids))).toBe(3);
    expect(findIndexNear("r0", 5000, ids.length, keysOf(ids))).toBe(0);
    expect(findIndexNear("missing", 10, ids.length, keysOf(ids))).toBe(-1);
  });
});

describe("new spans below the view", () => {
  // Rows 0–9 are in view; the newest run's spans are s0..s29 at rows 10.., some new.
  const setup = (
    seenIds: string[],
    hidden: string[] = [],
    notInTreeYet: string[] = [],
    stored: string[] = []
  ) => {
    const ids = rows("s", 30);
    const visible = ids.filter((id) => !hidden.includes(id) && !notInTreeYet.includes(id));
    const seen = new Set(seenIds);
    const count = (spanNodeIds: string[]) =>
      countNewSpansBelow({
        spanNodeIds,
        seen,
        inTree: (id) => !notInTreeYet.includes(id),
        visibleIndexOf: (id) => (visible.includes(id) ? 10 + visible.indexOf(id) : -1),
        viewEnd: 10,
        isLive: (id) => !stored.includes(id),
      });
    return { ids, seen, count };
  };

  // Catches: spans the live run gained below the view not showing the pill.
  it("counts spans new to the tree whose rows are below the view, once", () => {
    const { ids, count } = setup(rows("s", 25));
    expect(count(ids)).toBe(5);
    expect(count(ids)).toBe(0);
  });

  // Catches: expanding a span or widening a search counting rows that were already there
  // (review round 5, 2026-10-30).
  it("never counts a span that was hidden when it arrived, once it's shown", () => {
    const { ids, seen, count } = setup(rows("s", 25), ["s27", "s28"]);
    expect(count(ids)).toBe(3);
    expect(seen.has("s27")).toBe(true);
    expect(count(ids)).toBe(0);
  });

  // Catches: a span marked seen before the tree took its row, then never counted.
  it("leaves spans the tree hasn't taken yet for the next check", () => {
    const { ids, seen } = setup(rows("s", 25), [], ["s29"]);
    countNewSpansBelow({
      spanNodeIds: ids,
      seen,
      inTree: (id) => id !== "s29",
      visibleIndexOf: () => -1,
      viewEnd: 10,
      isLive: () => true,
    });
    expect(seen.has("s29")).toBe(false);
  });

  // Catches: a stored page landing below the view counting as new spans.
  it("sees stored spans without counting them", () => {
    const { ids, seen, count } = setup(rows("s", 25), [], [], ["s25", "s26"]);
    expect(count(ids)).toBe(3);
    expect(seen.has("s25")).toBe(true);
  });

  // Catches: a live run's first spans being dropped (review round 5): nothing about a run's first
  // spans is special once the opening hold has seen them.
  it("counts a run's first spans like any others", () => {
    const { ids, count } = setup([]);
    expect(count(ids)).toBe(30);
  });
});

describe("the new-below pill", () => {
  // Catches: a new run below losing to a span count, or the count growing without bound.
  it("lets a new run win and caps the count", () => {
    expect(pillLabel({ rows: 40, newRunId: "run_26" })).toMatch(/New run/);
    expect(pillLabel({ rows: 3_000, newRunId: undefined })).toMatch(/99\+/);
  });

  // Catches: the count re-rendering on every chunk instead of about once a second.
  it("shows the first count at once, then changes at most once a second", () => {
    expect(pillUpdateDelayMs(undefined, 5_000)).toBe(0);
    expect(pillUpdateDelayMs(5_000, 5_200)).toBe(PILL_UPDATE_MS - 200);
    expect(pillUpdateDelayMs(5_000, 7_000)).toBe(0);
  });
});
