import { describe, expect, it } from "vitest";
import { TraceScrollModel, type RowsView } from "~/components/sessions/v1/trace/sessionTraceScroll";

const ROW = 32;
const VIEWPORT = 10 * ROW;
const SKIP = new Set(["session", "loadEarlier"]);

/**
 * A small session tree as the model sees it: the visible rows in order, plus rows that are in the
 * tree but hidden (collapsed or filtered out). Each step changes the rows like the real tab would.
 */
class FakeTab {
  rows: string[];
  hidden = new Set<string>();
  scrollTop = 0;
  active = true;
  newestRunId = "run_3";
  openRunDone = true;
  /** Spans that arrived from the live tail; every other span came from a stored read. */
  live = new Set<string>();
  filterSettled = true;
  model: TraceScrollModel;

  constructor(rows: string[], { holdAtLatest = false, newestRunId = "run_3" } = {}) {
    this.rows = rows;
    this.newestRunId = newestRunId;
    this.model = new TraceScrollModel({
      rowHeightPx: ROW,
      holdAtLatest,
      skipAnchor: (id) => SKIP.has(id),
    });
  }

  view(): RowsView {
    const rows = this.rows;
    return {
      count: rows.length,
      keyAt: (index) => rows[index],
      visibleIndexOf: (id) => rows.indexOf(id),
      inTree: (id) => rows.includes(id) || this.hidden.has(id),
      scrollTop: this.scrollTop,
      viewportPx: VIEWPORT,
    };
  }

  /** The newest run's span rows, visible or hidden. */
  newestSpans() {
    const prefix = `span:${this.newestRunId}:`;
    return [...this.rows, ...this.hidden].filter((id) => id.startsWith(prefix));
  }

  change(rows: string[], hidden: string[] = []) {
    this.rows = rows;
    this.hidden = new Set(hidden);
    const scrollTop = this.model.rowsChanged({
      view: this.view(),
      active: this.active,
      newestRunId: this.newestRunId,
      newestSpanIds: this.newestSpans(),
      isLiveSpan: (id) => this.live.has(id),
      openRunDone: this.openRunDone,
      filterSettled: () => this.filterSettled,
      visibleTargetOf: (id) => (this.rows.includes(id) ? id : undefined),
    });
    if (scrollTop !== undefined) this.scrollTop = scrollTop;
  }

  /** Marks spans as arrived from the live tail and returns them. */
  tail(ids: string[]) {
    for (const id of ids) this.live.add(id);
    return ids;
  }

  scrollTo(scrollTop: number) {
    this.scrollTop = scrollTop;
    this.model.scrolled(this.view());
  }

  topRow() {
    return this.rows[Math.floor(this.scrollTop / ROW)];
  }
}

const spans = (run: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `span:${run}:${from + i}`);
const runsWithSpans = (newest: string, count: number) => [
  "session",
  "loadEarlier",
  "run:run_1",
  ...spans("run_1", 1, 10),
  "run:run_2",
  ...spans("run_2", 1, 10),
  `run:${newest}`,
  ...spans(newest, 1, count),
];

describe("the session trace scroll model", () => {
  // Catches: the view sliding as live spans land above it.
  it("keeps the top row in place when rows land above it", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 20));
    tab.change(tab.rows);
    tab.scrollTo(20 * ROW);
    const top = tab.topRow();
    const rows = [...tab.rows];
    rows.splice(5, 0, "span:run_1:extra-a", "span:run_1:extra-b");
    tab.change(rows);
    expect(tab.topRow()).toBe(top);
  });

  // Catches: Load earlier moving the view, or (round 6) moving it twice when live spans arrived
  // during its request.
  it("keeps the oldest run in place when earlier runs land, live spans meanwhile or not", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 5));
    tab.change(tab.rows);
    tab.scrollTo(0);
    // The request is out: live spans keep arriving below.
    tab.change([...tab.rows, ...spans("run_3", 6, 9)]);
    expect(tab.scrollTop).toBe(0);
    // Earlier runs land between the session row and the oldest run.
    const before = tab.rows.indexOf("run:run_1") * ROW - tab.scrollTop;
    const earlier = ["run:run_0a", "run:run_0b", "run:run_0c"];
    tab.change(["session", ...earlier, ...tab.rows.slice(2)]);
    expect(tab.rows.indexOf("run:run_1") * ROW - tab.scrollTop).toBe(before);
  });

  // Catches: live spans below the view not showing the pill, or the view following them.
  it("counts new spans below the view without moving it", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 20));
    tab.change(tab.rows);
    tab.scrollTo(5 * ROW);
    tab.change([...tab.rows, ...tab.tail(spans("run_3", 21, 23))]);
    expect(tab.scrollTop).toBe(5 * ROW);
    expect(tab.model.pill.rows).toBe(3);
  });

  // Catches: expanding an older run in view pushing the newest run's rows down and counting them.
  it("doesn't count rows pushed below by another run loading", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 5));
    tab.change(tab.rows);
    tab.scrollTo(0);
    const rows = [...tab.rows];
    rows.splice(rows.indexOf("run:run_2") + 1, 0, ...spans("run_2", 11, 40));
    tab.change(rows);
    expect(tab.model.pill.rows).toBe(0);
  });

  // Catches: a search hiding new spans, then its clearing counting them (round 5).
  it("never counts spans that arrived hidden, once they're shown", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 20));
    tab.change(tab.rows);
    tab.scrollTo(5 * ROW);
    // Filtered out while a search is on.
    tab.change(tab.rows, tab.tail(spans("run_3", 21, 26)));
    expect(tab.model.pill.rows).toBe(0);
    // The search is cleared: they show, but aren't new.
    tab.change([...tab.rows, ...spans("run_3", 21, 26)]);
    expect(tab.model.pill.rows).toBe(0);
  });

  // Catches: a span seen before the tree had its row, then never counted.
  it("counts a span once the tree takes its row", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 20));
    tab.change(tab.rows);
    tab.scrollTo(5 * ROW);
    const late = "span:run_3:21";
    // The trace has it, the tree doesn't yet.
    const spansWithLate = tab.newestSpans().concat(late);
    tab.model.rowsChanged({
      view: tab.view(),
      active: true,
      newestRunId: "run_3",
      newestSpanIds: spansWithLate,
      isLiveSpan: () => true,
      openRunDone: true,
      filterSettled: () => true,
      visibleTargetOf: (id) => id,
    });
    expect(tab.model.waitingForSpans).toBe(true);
    tab.change([...tab.rows, ...tab.tail([late])]);
    expect(tab.model.pill.rows).toBe(1);
  });

  // Catches: opening with a pill for spans the user never saw, or (round 5) a live run's first
  // spans landing off screen with no pill.
  it("holds at the latest run until the opened run's first spans are in", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 0), { holdAtLatest: true });
    tab.openRunDone = false;
    tab.change(tab.rows);
    // Spans arrive later; the hold follows them, then ends.
    tab.openRunDone = true;
    tab.change([...tab.rows, ...spans("run_3", 1, 30)]);
    expect(tab.scrollTop).toBe(tab.rows.length * ROW - VIEWPORT);
    expect(tab.model.pill.rows).toBe(0);
    expect(tab.model.holdingAtLatest).toBe(false);
    // From now on the view stays and the pill counts.
    const at = tab.scrollTop;
    tab.change([...tab.rows, ...tab.tail(spans("run_3", 31, 32))]);
    expect(tab.scrollTop).toBe(at);
    expect(tab.model.pill.rows).toBe(2);
  });

  // Catches: a deep link (no hold) opening with a pill for the spans already there, found by these
  // sequence tests (2026-10-30).
  it("treats the first look at the newest run as a baseline", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 40));
    tab.scrollTo(0);
    tab.change(tab.rows);
    expect(tab.model.pill.rows).toBe(0);
    tab.change([...tab.rows, ...tab.tail(spans("run_3", 41, 42))]);
    expect(tab.model.pill.rows).toBe(2);
  });

  // Catches: stored pages counted as new spans: a deep link opening with "↓ 41 new spans"
  // (independent review), or "↓ 99+" when a big run's last page landed a render after its read
  // ended (review round 7).
  it("never counts a run's stored spans, whenever they land", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 0));
    tab.change(tab.rows);
    tab.scrollTo(0);
    tab.change([...tab.rows, ...spans("run_3", 1, 40)]);
    tab.change([...tab.rows, ...spans("run_3", 41, 60)]);
    tab.change([...tab.rows]);
    expect(tab.model.pill.rows).toBe(0);
    tab.change([...tab.rows, ...tab.tail(["span:run_3:61"])]);
    expect(tab.model.pill.rows).toBe(1);
  });

  // Catches: "↓ New run" lost when the new run's row reached the tree a render late (review
  // round 7).
  it("still says a new run is below when its row arrives a render later", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 40));
    tab.change(tab.rows);
    tab.scrollTo(5 * ROW);
    tab.newestRunId = "run_4";
    tab.change([...tab.rows]);
    expect(tab.model.pill.newRunId).toBeUndefined();
    tab.change([...tab.rows, "run:run_4"]);
    expect(tab.model.pill.newRunId).toBe("run_4");
  });

  // Catches: a new run's first chunk (stored spans) hiding "↓ New run".
  it("still says a new run is below while its first chunk loads", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 40));
    tab.change(tab.rows);
    tab.scrollTo(5 * ROW);
    tab.newestRunId = "run_4";
    tab.change([...tab.rows, "run:run_4", ...spans("run_4", 1, 3)]);
    expect(tab.model.pill.newRunId).toBe("run_4");
    expect(tab.model.pill.rows).toBe(0);
  });

  // Catches: a root-only run that was complete on its first snapshot never counting its first
  // live spans, since no render saw it loading (PR review, Pullfrog).
  it("counts the first live spans of a run whose stored read had no span rows", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 0), { holdAtLatest: true });
    tab.openRunDone = false;
    tab.change(tab.rows);
    // Snapshot and settle land in one render: the hold ends with no span rows.
    tab.openRunDone = true;
    tab.change([...tab.rows]);
    tab.model.interacted();
    tab.scrollTo(0);
    tab.change([...tab.rows, ...tab.tail(["span:run_3:1"])]);
    expect(tab.model.pill.rows).toBe(1);
  });

  // Catches: rows landing above the view while the tab is hidden moving the view on return (PR
  // review, Pullfrog).
  it("keeps the anchor from before the tab was hidden", () => {
    const tab = new FakeTab(Array.from({ length: 40 }, (_, i) => `row${i}`));
    tab.change(tab.rows);
    tab.scrollTo(10 * ROW);
    tab.active = false;
    tab.change(["new0", "new1", "new2", ...tab.rows]);
    tab.active = true;
    tab.change([...tab.rows]);
    expect(tab.topRow()).toBe("row10");
  });

  // Catches: the hold scrolling after the user took over.
  it("stops holding as soon as the user interacts", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 30), { holdAtLatest: true });
    tab.openRunDone = false;
    tab.change(tab.rows);
    tab.model.interacted();
    tab.scrollTo(4 * ROW);
    tab.change([...tab.rows, ...spans("run_3", 31, 35)]);
    expect(tab.scrollTop).toBe(4 * ROW);
  });

  // Catches: a new run below losing to a span count, or its click not landing on the run.
  it("says a new run is below, and its click puts the run row at the top", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 40));
    tab.change(tab.rows);
    tab.scrollTo(5 * ROW);
    tab.newestRunId = "run_4";
    tab.change([...tab.rows, "run:run_4", ...spans("run_4", 1, 3)]);
    expect(tab.model.pill.newRunId).toBe("run_4");
    const scrollTop = tab.model.pillClicked(tab.view());
    expect(scrollTop).toBe(
      Math.min(tab.rows.indexOf("run:run_4") * ROW, tab.rows.length * ROW - VIEWPORT)
    );
    expect(tab.model.pill.rows).toBe(0);
  });

  // Catches: the pill staying after the user scrolled down to what was new.
  it("clears the pill when the user scrolls to the bottom", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 40));
    tab.change(tab.rows);
    tab.scrollTo(5 * ROW);
    tab.change([...tab.rows, ...tab.tail(spans("run_3", 41, 45))]);
    expect(tab.model.pill.rows).toBe(5);
    tab.scrollTo(tab.rows.length * ROW - VIEWPORT);
    expect(tab.model.pill.rows).toBe(0);
  });

  // Catches: a deep link scrolling before its row exists, or after the user moved on.
  it("reveals a row once it's visible, unless the user moved on", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 40));
    tab.model.reveal({
      id: "span:run_2:9",
      align: "center",
      cancelOnInteraction: true,
      waitForFilter: false,
    });
    tab.change(tab.rows.filter((id) => id !== "span:run_2:9"));
    expect(tab.scrollTop).toBe(0);
    tab.change(runsWithSpans("run_3", 40));
    const index = tab.rows.indexOf("span:run_2:9");
    expect(tab.scrollTop).toBe(index * ROW - (VIEWPORT - ROW) / 2);

    tab.model.reveal({
      id: "span:run_1:2",
      align: "center",
      cancelOnInteraction: true,
      waitForFilter: false,
    });
    tab.model.interacted();
    const at = tab.scrollTop;
    tab.change([...tab.rows]);
    expect(tab.scrollTop).toBe(at);
  });

  // Catches: clearing a search scrolling before the tree has dropped the filter.
  it("waits for the filter to drop before a clear-search scroll", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 40));
    tab.change(tab.rows);
    tab.model.reveal({
      id: "span:run_3:30",
      align: "start",
      cancelOnInteraction: false,
      waitForFilter: true,
    });
    tab.filterSettled = false;
    tab.change([...tab.rows]);
    expect(tab.scrollTop).toBe(0);
    tab.filterSettled = true;
    tab.change([...tab.rows]);
    expect(tab.topRow()).toBe("span:run_3:30");
  });

  // Catches: rows added while the tab is hidden moving the view or counting as new later.
  it("holds still and counts nothing while hidden", () => {
    const tab = new FakeTab(runsWithSpans("run_3", 20));
    tab.change(tab.rows);
    tab.scrollTo(5 * ROW);
    tab.active = false;
    tab.change([...tab.rows, ...tab.tail(spans("run_3", 21, 25))]);
    expect(tab.scrollTop).toBe(5 * ROW);
    tab.active = true;
    tab.change([...tab.rows]);
    expect(tab.model.pill.rows).toBe(0);
  });
});
