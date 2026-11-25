import { runNodeId } from "./buildSessionTree";

/** Where the view is: the row at the top and how far it's scrolled into that row. */
/** `topPx` is where the anchor row's top was when the anchor was taken. */
export type ScrollAnchor = { id: string; index: number; offsetPx: number; topPx: number };

/** Rows added below the view that the "new below" pill reports. */
export type NewBelow = { rows: number; newRunId: string | undefined };

export const NO_NEW_BELOW: NewBelow = { rows: 0, newRunId: undefined };

/** The pill's count changes at most this often, so a burst of spans doesn't blur it. */
export const PILL_UPDATE_MS = 1_000;

const PILL_COUNT_CAP = 99;

/**
 * The row the view is anchored on: the top row, or the first row below it that `skip` allows.
 * Skipping the rows above the runs (the session row, "Load earlier") means earlier runs landing
 * above the oldest run keep it in place, the same as any other rows added above the view.
 * `offsetPx` is negative when the anchor row is below the top.
 */
export function anchorAt(
  scrollTop: number,
  rows: RowGeometry,
  keyAt: (index: number) => string | undefined,
  skip: (id: string) => boolean = () => false
): ScrollAnchor | undefined {
  for (let index = rows.indexAt(scrollTop); ; index++) {
    const id = keyAt(index);
    if (id === undefined) return undefined;
    if (skip(id)) continue;
    const topPx = rows.topOf(index);
    return { id, index, offsetPx: scrollTop - topPx, topPx };
  }
}

/**
 * The index of `id` among the visible rows, searched outwards from `hint`: inserts and removals
 * near the view move a row by a few places, so this rarely walks far.
 */
export function findIndexNear(
  id: string,
  hint: number,
  count: number,
  keyAt: (index: number) => string | undefined
): number {
  const start = Math.min(Math.max(hint, 0), count - 1);
  for (let distance = 0; distance < count; distance++) {
    const below = start + distance;
    const above = start - distance;
    if (below >= count && above < 0) break;
    if (below < count && keyAt(below) === id) return below;
    if (distance > 0 && above >= 0 && keyAt(above) === id) return above;
  }
  return -1;
}

/**
 * Where to scroll so the anchored row stays put after rows were added or removed above it.
 * Undefined when the row is gone or hasn't moved.
 */
export function anchoredScrollTop(
  anchor: ScrollAnchor,
  count: number,
  rows: RowGeometry,
  keyAt: (index: number) => string | undefined
): number | undefined {
  const index = findIndexNear(anchor.id, anchor.index, count, keyAt);
  if (index === -1) return undefined;
  const scrollTop = rows.topOf(index) + anchor.offsetPx;
  // Same index can still move: a row of another height was swapped in above it.
  return index === anchor.index && scrollTop === anchor.topPx ? undefined : scrollTop;
}

/**
 * Counts the newest run's spans that are new since the last check and whose rows landed below the
 * view, and marks every span that's in the tree as seen. Counting spans by id, not visible rows,
 * means an expand, a search or another run loading can't look like new data: those rows' spans
 * were seen already. A span not in the tree yet (the tree takes rows a render after the trace)
 * stays unseen until it is; one in the tree but hidden (collapsed, filtered out) is seen without
 * counting, so expanding it later adds nothing.
 */
export function countNewSpansBelow({
  spanNodeIds,
  seen,
  inTree,
  visibleIndexOf,
  viewEnd,
  isLive,
}: {
  spanNodeIds: Iterable<string>;
  seen: Set<string>;
  inTree: (id: string) => boolean;
  /** The row's index among the visible rows, or -1 when it's hidden. */
  visibleIndexOf: (id: string) => number;
  viewEnd: number;
  /** Spans that arrived from the live tail; the run's stored spans are seen, never counted. */
  isLive: (id: string) => boolean;
}): number {
  let below = 0;
  for (const id of spanNodeIds) {
    if (seen.has(id) || !inTree(id)) continue;
    seen.add(id);
    if (isLive(id) && visibleIndexOf(id) >= viewEnd) below++;
  }
  return below;
}

export function pillLabel(newBelow: NewBelow): string | undefined {
  if (newBelow.newRunId) return "↓ New run";
  if (newBelow.rows === 0) return undefined;
  const count = newBelow.rows > PILL_COUNT_CAP ? `${PILL_COUNT_CAP}+` : String(newBelow.rows);
  return `↓ ${count} new span${newBelow.rows === 1 ? "" : "s"}`;
}

/** How long to wait before showing a changed count, given when the pill last changed. */
export function pillUpdateDelayMs(lastShownAtMs: number | undefined, nowMs: number): number {
  if (lastShownAtMs === undefined) return 0;
  return Math.max(0, lastShownAtMs + PILL_UPDATE_MS - nowMs);
}

export type RowGeometry = {
  /** Top of the row at `index`, in px from the top of the list. */
  topOf: (index: number) => number;
  heightOf: (index: number) => number;
  totalPx: number;
  /** The row under a scroll position: the last row whose top is at or above it. */
  indexAt: (px: number) => number;
};

/** A geometry from each visible row's height, top to bottom. */
export function rowGeometry(heights: number[]): RowGeometry {
  const tops: number[] = [];
  let total = 0;
  for (const height of heights) {
    tops.push(total);
    total += height;
  }
  return {
    topOf: (index) => tops[index] ?? total,
    heightOf: (index) => heights[index] ?? 0,
    totalPx: total,
    indexAt: (px) => {
      let low = 0;
      let high = tops.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (tops[mid] <= px) low = mid;
        else high = mid - 1;
      }
      return Math.max(0, low);
    },
  };
}

/** What the visible rows look like now. */
export type RowsView = RowGeometry & {
  count: number;
  keyAt: (index: number) => string | undefined;
  /** A row's index among the visible rows, or -1 when it's hidden or filtered out. */
  visibleIndexOf: (id: string) => number;
  inTree: (id: string) => boolean;
  scrollTop: number;
  viewportPx: number;
};

export type Reveal = {
  id: string;
  align: "start" | "center";
  /** A deep link stops on the user's own scroll, click or key; a clear-search scroll doesn't. */
  cancelOnInteraction: boolean;
  /** Clearing a search: wait until the tree has dropped the filter. */
  waitForFilter: boolean;
};

/**
 * Every scroll decision of the session Trace tab in one place: the opening hold at the latest
 * run, a pending reveal (deep link, clearing a search), anchoring the view when rows are added
 * above it, and the "new below" pill. The tab reports what happened and applies the scrollTop
 * it gets back; nothing else moves the view.
 */
export class TraceScrollModel {
  #holdAtLatest: boolean;
  #reveal: Reveal | undefined;
  #anchor: ScrollAnchor | undefined;
  #skipAnchor: (id: string) => boolean;
  #seen: { runId: string | undefined; ids: Set<string>; waiting: boolean } = {
    runId: undefined,
    ids: new Set(),
    waiting: false,
  };
  #pill: NewBelow = NO_NEW_BELOW;
  /** A new run whose row isn't in the visible rows yet: decided once it is. */
  #pendingNewRun: string | undefined;

  constructor({
    holdAtLatest,
    reveal,
    skipAnchor,
  }: {
    /** Opening without a deep link: stay at the latest run until its first spans are in. */
    holdAtLatest: boolean;
    /** Opening on a deep link: the row to reveal once it's visible. */
    reveal?: Reveal;
    /** Rows never used as the anchor (the session row and "Load earlier"). */
    skipAnchor: (id: string) => boolean;
  }) {
    this.#holdAtLatest = holdAtLatest;
    this.#reveal = reveal;
    this.#skipAnchor = skipAnchor;
  }

  get pill() {
    return this.#pill;
  }

  /** Whether some of the newest run's spans weren't in the tree yet at the last check. */
  get waitingForSpans() {
    return this.#seen.waiting;
  }

  /**
   * The visible rows changed (rows added, expanded, collapsed, filtered), or the opened run
   * finished loading. Returns where to scroll, if anywhere.
   */
  rowsChanged({
    view,
    active,
    newestRunId,
    newestSpanIds,
    isLiveSpan,
    filterSettled,
    visibleTargetOf,
  }: {
    view: RowsView;
    /** False while the tab is hidden: nothing moves and nothing counts. */
    active: boolean;
    newestRunId: string | undefined;
    /** The newest run's span row ids (not its root, which has no row), or an empty list when
     * they can't have changed. */
    newestSpanIds: Iterable<string>;
    /** Spans the newest run first got from its live tail, not from a stored read. */
    isLiveSpan: (id: string) => boolean;
    filterSettled: () => boolean;
    /** The row to scroll to for a target: itself, or its nearest visible ancestor. */
    visibleTargetOf: (id: string) => string | undefined;
  }): number | undefined {
    let scrollTop: number | undefined;
    let steered = true;
    if (!active) {
      // Hidden: hold everything as it is.
    } else if (this.#holdAtLatest) {
      // Nothing opens on load, so the hold lasts one pass.
      scrollTop = this.#maxScrollTop(view);
      this.#holdAtLatest = false;
    } else {
      scrollTop = this.#tryReveal(view, filterSettled, visibleTargetOf);
      // Until a reveal can happen (its row isn't there yet), the view stays anchored.
      if (scrollTop === undefined) {
        steered = false;
        if (this.#anchor) {
          scrollTop = anchoredScrollTop(this.#anchor, view.count, view, view.keyAt);
        }
      }
    }
    const top = scrollTop ?? view.scrollTop;

    // The pill: only spans that arrived from the live tail count. Stored spans (first chunk,
    // pages, errors-only, deep link) are history wherever the view is; nothing counts while
    // something else steers the view.
    // The first row that starts at or below the view's bottom edge.
    const bottomPx = top + view.viewportPx;
    const lastInView = view.indexAt(bottomPx);
    const viewEnd = view.topOf(lastInView) >= bottomPx ? lastInView : lastInView + 1;
    if (this.#seen.runId !== newestRunId) {
      const runChanged = this.#seen.runId !== undefined && newestRunId !== undefined;
      this.#seen = { runId: newestRunId, ids: new Set(), waiting: false };
      this.#pendingNewRun = runChanged ? newestRunId : undefined;
    }
    const counting = !steered;
    // One pass over the visible rows, built only when a new span has to be placed.
    let indexById: Map<string, number> | undefined;
    const visibleIndexOf = (id: string) => {
      if (!counting) return -1;
      if (!indexById) {
        indexById = new Map();
        for (let index = 0; index < view.count; index++) {
          const key = view.keyAt(index);
          if (key !== undefined) indexById.set(key, index);
        }
      }
      return indexById.get(id) ?? -1;
    };
    let waiting = false;
    const added = countNewSpansBelow({
      spanNodeIds: newestSpanIds,
      seen: this.#seen.ids,
      inTree: (id) => {
        const inTree = view.inTree(id);
        if (!inTree) waiting = true;
        return inTree;
      },
      visibleIndexOf,
      viewEnd,
      isLive: isLiveSpan,
    });
    this.#seen.waiting = waiting;
    // The new run's row can reach the visible rows a render after the run list changes.
    let newRunBelow: string | undefined;
    if (this.#pendingNewRun !== undefined) {
      const index = this.#newRunRowIndex(view, this.#pendingNewRun);
      if (index !== -1) {
        if (index >= viewEnd) newRunBelow = this.#pendingNewRun;
        this.#pendingNewRun = undefined;
      }
    }
    if (!steered && ((counting && added > 0) || newRunBelow)) {
      this.#pill = {
        rows: this.#pill.rows + (counting ? added : 0),
        newRunId: newRunBelow ?? this.#pill.newRunId,
      };
    }

    // Hidden: keep the anchor from before, so rows that land meanwhile are reconciled on return.
    if (active) this.#record(view, top);
    return scrollTop === view.scrollTop ? undefined : scrollTop;
  }

  /** The user (or the browser) scrolled. Scrolling to the bottom has seen what was new. */
  scrolled(view: RowsView) {
    this.#record(view, view.scrollTop);
    if (view.scrollTop >= this.#maxScrollTop(view) - view.heightOf(view.count - 1)) {
      this.#pill = NO_NEW_BELOW;
    }
  }

  /** The user's own scroll, click or key in the tab: stop holding and stop a deep-link reveal. */
  interacted() {
    this.#holdAtLatest = false;
    if (this.#reveal?.cancelOnInteraction) this.#reveal = undefined;
  }

  /**
   * Scrolls to a row. With `view`, a row already on the list scrolls now (nothing else would
   * trigger a pass); otherwise it waits for the rows to change, like a row that's still opening.
   */
  reveal(reveal: Reveal, view?: RowsView): number | undefined {
    this.#reveal = reveal;
    if (!view) return undefined;
    const scrollTop = this.#tryReveal(
      view,
      () => true,
      (id) => id
    );
    if (scrollTop !== undefined) this.#record(view, scrollTop);
    return scrollTop;
  }

  /** The pill was clicked: a new run's row goes to the top, new spans to the bottom. */
  pillClicked(view: RowsView): number {
    const { newRunId } = this.#pill;
    this.#pill = NO_NEW_BELOW;
    const index = newRunId ? this.#newRunRowIndex(view, newRunId) : -1;
    const scrollTop =
      index === -1 ? this.#maxScrollTop(view) : this.#scrollTopFor(view, index, "start");
    this.#record(view, scrollTop);
    return scrollTop;
  }

  #tryReveal(
    view: RowsView,
    filterSettled: () => boolean,
    visibleTargetOf: (id: string) => string | undefined
  ): number | undefined {
    const reveal = this.#reveal;
    if (!reveal || (reveal.waitForFilter && !filterSettled())) return undefined;
    const target = visibleTargetOf(reveal.id);
    const index = target === undefined ? -1 : view.visibleIndexOf(target);
    if (index === -1) return undefined;
    this.#reveal = undefined;
    return this.#scrollTopFor(view, index, reveal.align);
  }

  #newRunRowIndex(view: RowsView, runId: string) {
    return view.visibleIndexOf(runNodeId(runId));
  }

  #maxScrollTop(view: RowsView) {
    return Math.max(0, view.totalPx - view.viewportPx);
  }

  #scrollTopFor(view: RowsView, index: number, align: "start" | "center") {
    const rowTop = view.topOf(index);
    const top = align === "start" ? rowTop : rowTop - (view.viewportPx - view.heightOf(index)) / 2;
    return Math.min(Math.max(0, top), this.#maxScrollTop(view));
  }

  #record(view: RowsView, scrollTop: number) {
    this.#anchor = anchorAt(
      Math.min(Math.max(0, scrollTop), this.#maxScrollTop(view)),
      view,
      view.keyAt,
      this.#skipAnchor
    );
  }
}
