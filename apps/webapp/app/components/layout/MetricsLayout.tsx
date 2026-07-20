/**
 * MetricsLayout — a compound layout for metric / dashboard pages.
 *
 * PHILOSOPHY — slots own their chrome. This family exists so that non-designers (and AI agents)
 * can compose a beautiful, consistent metrics page purely by picking slots and setting closed,
 * semantic props. There is deliberately NO freeform `className` on any slot: a page cannot restyle
 * the spacing, borders or gutters of the layout, because that is exactly how metric pages drifted
 * apart before. The slots bake ONE visual rhythm (a 12px grid gap, a 12px page gutter, a doubled
 * separation before the content, a pinned 40px filter bar). If you find yourself wanting a class on
 * a slot, you probably need a new semantic variant instead — talk to design and add a closed prop
 * (like `kind` or `inset`) rather than reopening `className`.
 *
 * Every metrics page reads top-to-bottom as the same slots:
 *
 *   1. `MetricsLayout.Filters` — the pinned bar under the NavBar (search, TimeFilter, pagination…).
 *      It is hoisted out of the scroll container so it stays put while the page scrolls. Baked
 *      chrome: a 40px bar with a bottom border. Pages express left/right clusters as child divs
 *      (e.g. left = search + TimeFilter, right = pagination); `justify-between` spreads them.
 *   2. `MetricsLayout.Grid` — one or more grids of tiles (stat BigNumbers, chart cards). The grid
 *      adapts its column count to the number of tiles unless you pass an explicit `columns` spec,
 *      and bakes the page gutter + grid gap. `kind="charts"` bakes the fixed chart-row height.
 *   3. `MetricsLayout.Content` — the tabs / table / list below the tiles. Full-bleed by default
 *      (a list table spans edge to edge with its own top border); pass `inset` for a padded column.
 *      Content always bakes a doubled separation (24px) above it, so the blocks read as a distinct
 *      band from the content below.
 *
 * Two optional structural capabilities extend the basic top-to-bottom column:
 *
 *   - `MetricsLayout.Sidebar` — a persistent side panel rendered to the RIGHT of the main column
 *     (main content left, sidebar right, full height). Drop a single `<MetricsLayout.Sidebar>`
 *     anywhere among Root's children and Root switches to a `[main | sidebar]` horizontal layout;
 *     omit it and nothing changes. The sidebar is fixed-width by default (`width`), or set
 *     `resizable` to make the split draggable via the shared Resizable primitives.
 *
 *   - `scroll` on Root — chooses who owns the vertical scroll:
 *       - `"page"` (default): Root owns a single `overflow-y-auto` and lays the slots out as a
 *         `flex` column with the standard vertical rhythm; the WHOLE page (filters aside) scrolls
 *         as one. This is what every current metrics page wants.
 *       - `"regions"`: Root does NOT create a scroll container and does NOT impose the column
 *         rhythm — it only bounds the height as a bare `flex` column. The page composes its own
 *         independently-scrolling areas inside the slots (e.g. a fixed toolbar over a scrolling
 *         table, or a vertical resizable split). Use this when a single page-level scroll would be
 *         wrong.
 *
 * The family is purely presentational — slots, grids, a sidebar and scroll ownership only, no data
 * logic. It is meant to live inside a `PageContainer` right after the `NavBar`.
 *
 * @example List page (full-bleed table, count-derived grids)
 * ```tsx
 * <PageContainer>
 *   <NavBar>…</NavBar>
 *   <MetricsLayout.Root>
 *     <MetricsLayout.Filters>
 *       <div className="flex items-center gap-2">…search + TimeFilter…</div>
 *       <PaginationControls … />
 *     </MetricsLayout.Filters>
 *     <MetricsLayout.Grid>…4 stat tiles…</MetricsLayout.Grid>
 *     <ChartSyncProvider>
 *       <MetricsLayout.Grid kind="charts">…4 chart tiles…</MetricsLayout.Grid>
 *     </ChartSyncProvider>
 *     <MetricsLayout.Content>…full-width table…</MetricsLayout.Content>
 *   </MetricsLayout.Root>
 * </PageContainer>
 * ```
 *
 * @example Detail page (a single padded column)
 * ```tsx
 * <MetricsLayout.Root>
 *   <MetricsLayout.Filters>
 *     <div className="flex items-center gap-2">…search + TimeFilter…</div>
 *   </MetricsLayout.Filters>
 *   <MetricsLayout.Grid>…3 stat tiles…</MetricsLayout.Grid>
 *   <MetricsLayout.Content inset>
 *     <TabContainer>…</TabContainer>
 *     …active view (charts / keys)…
 *   </MetricsLayout.Content>
 * </MetricsLayout.Root>
 * ```
 *
 * @example Page with a persistent config sidebar (fixed-width)
 * ```tsx
 * <MetricsLayout.Root>
 *   <MetricsLayout.Filters>…</MetricsLayout.Filters>
 *   <MetricsLayout.Content>…</MetricsLayout.Content>
 *   <MetricsLayout.Sidebar width="380px">…config panel…</MetricsLayout.Sidebar>
 * </MetricsLayout.Root>
 * ```
 *
 * @example Resizable sidebar + independently-scrolling regions
 * ```tsx
 * // In the loader, hydrate the persisted split from a cookie:
 * const sidebarSnapshot = await getResizableSnapshot(request, "my-page-sidebar");
 *
 * <MetricsLayout.Root scroll="regions">
 *   <div className="flex h-10 shrink-0 items-center …">…toolbar…</div>
 *   <div className="min-h-0 flex-1 overflow-y-auto">…scrolling body…</div>
 *   <MetricsLayout.Sidebar
 *     resizable
 *     autosaveId="my-page-sidebar"
 *     snapshot={sidebarSnapshot}
 *     min="280px"
 *     defaultSize="380px"
 *     max="500px"
 *   >
 *     …config panel…
 *   </MetricsLayout.Sidebar>
 * </MetricsLayout.Root>
 * ```
 */
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { PageBody } from "~/components/layout/AppLayout";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type ResizableSnapshot,
} from "~/components/primitives/Resizable";
import { cn } from "~/utils/cn";

type ColumnCount = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * A responsive column spec. Each key is a breakpoint (mobile-first `base`, then `sm`/`md`/`lg`);
 * the value is the number of grid columns from that breakpoint up. Pass this to `Grid` when the
 * tile count shouldn't drive the layout (e.g. a chart grid that is always two-up).
 */
export type GridColumns = {
  base?: ColumnCount;
  sm?: ColumnCount;
  md?: ColumnCount;
  lg?: ColumnCount;
};

// Static class maps so Tailwind's scanner sees every column class as a literal string.
const BASE_COLS: Record<ColumnCount, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
};
const SM_COLS: Record<ColumnCount, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
  5: "sm:grid-cols-5",
  6: "sm:grid-cols-6",
};
const MD_COLS: Record<ColumnCount, string> = {
  1: "md:grid-cols-1",
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
  5: "md:grid-cols-5",
  6: "md:grid-cols-6",
};
const LG_COLS: Record<ColumnCount, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
};

// When `columns` is omitted the grid figures itself out from the tile count. The breakpoints are
// chosen so the common metric layouts fall out for free: a trio of stat blocks goes one-up then
// three-up, a quartet of stat/chart tiles goes two-up then four-up, and anything larger settles
// into a comfortable two-up.
function columnsForCount(count: number): GridColumns {
  switch (count) {
    case 1:
      return { base: 1 };
    case 2:
      return { base: 1, sm: 2 };
    case 3:
      return { base: 1, sm: 3 };
    case 4:
      return { base: 2, lg: 4 };
    default:
      return { base: 1, sm: 2 };
  }
}

/**
 * Who owns the vertical scroll.
 *   - `"page"` (default): Root owns one `overflow-y-auto` and the column rhythm — the whole page
 *     scrolls as one.
 *   - `"regions"`: Root only bounds the height (a bare `flex` column, no scroll, no rhythm); the
 *     page composes its own scrolling areas inside the slots.
 */
export type MetricsScroll = "page" | "regions";

type MetricsLayoutSidebarProps = {
  children: ReactNode;
  /**
   * Fixed sidebar width for the non-resizable default (any CSS length, e.g. `"380px"`, `"22rem"`).
   * Ignored when `resizable` is set. Defaults to `"380px"`.
   */
  width?: string;
  /**
   * When true, the `[main | sidebar]` split becomes draggable using the shared Resizable
   * primitives. Persist the split by passing a stable `autosaveId` (the primitive writes the
   * split to a cookie of that name) together with a `snapshot` read back from that cookie in the
   * loader via `getResizableSnapshot(request, autosaveId)`.
   */
  resizable?: boolean;
  /** Resizable only: min width of the sidebar panel. Defaults to `"280px"`. */
  min?: string;
  /** Resizable only: initial width of the sidebar panel. Defaults to `"380px"`. */
  defaultSize?: string;
  /** Resizable only: max width of the sidebar panel. */
  max?: string;
  /** Resizable only: min width of the main panel. Defaults to `"300px"`. */
  mainMin?: string;
  /** Resizable only: cookie name the split is persisted under (also the panel-group id). */
  autosaveId?: string;
  /** Resizable only: server-loaded split snapshot to hydrate from (see `getResizableSnapshot`). */
  snapshot?: ResizableSnapshot;
};

/**
 * Marker slot for the persistent side panel. Rendered/positioned entirely by `Root` (this
 * component is never mounted directly) — Root reads its props to build the `[main | sidebar]`
 * layout and drops the children into the panel. The panel itself owns its chrome (border, scroll);
 * pass those as part of the children, not as a class on the slot.
 */
function MetricsLayoutSidebar(_props: MetricsLayoutSidebarProps) {
  return null;
}

function isSidebarElement(child: ReactNode): child is ReactElement<MetricsLayoutSidebarProps> {
  return isValidElement(child) && child.type === MetricsLayoutSidebar;
}

function isFiltersElement(child: ReactNode): child is ReactElement {
  return isValidElement(child) && child.type === MetricsLayoutFilters;
}

// The main (left) column. The Filters slot is hoisted OUT of the scroll container so it stays
// pinned while the tiles/content scroll underneath (the dashboards' `[auto | 1fr]` pattern —
// sticky without z-index/backdrop bookkeeping). In `"page"` mode the rest scrolls as one and gets
// the baked column rhythm (vertical gap + top/bottom padding); in `"regions"` mode the page
// composes its own scrolling areas, so the container stays bare.
function MetricsLayoutMain({ children, scroll }: { children: ReactNode; scroll: MetricsScroll }) {
  const arr = Children.toArray(children);
  const filters = arr.find(isFiltersElement);
  const rest = filters ? arr.filter((child) => !isFiltersElement(child)) : children;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {filters}
      <div
        className={
          scroll === "page"
            ? "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
            : "flex min-h-0 flex-1 flex-col overflow-hidden"
        }
      >
        {rest}
      </div>
    </div>
  );
}

function MetricsLayoutRoot({
  children,
  scroll = "page",
}: {
  children: ReactNode;
  /** Who owns the vertical scroll — see {@link MetricsScroll}. Defaults to `"page"`. */
  scroll?: MetricsScroll;
}) {
  // A single optional Sidebar slot flips Root into a horizontal `[main | sidebar]` layout. When it
  // is absent the output is the plain single-column markup.
  const sidebar = Children.toArray(children).find(isSidebarElement);
  const mainChildren = sidebar
    ? Children.toArray(children).filter((child) => !isSidebarElement(child))
    : children;

  const main = <MetricsLayoutMain scroll={scroll}>{mainChildren}</MetricsLayoutMain>;

  if (!sidebar) {
    return (
      <PageBody scrollable={false}>
        {/* The whole page scrolls as one: filters (pinned) aside, the tiles and content share a
            single vertical scroll context. */}
        {main}
      </PageBody>
    );
  }

  const {
    children: sidebarChildren,
    width = "380px",
    resizable,
    min = "280px",
    defaultSize = "380px",
    max,
    mainMin = "300px",
    autosaveId,
    snapshot,
  } = sidebar.props;

  if (resizable) {
    // Draggable split. `autosaveId`/`snapshot` wire up cookie persistence exactly as the run and
    // agent pages do (client writes the cookie, the loader hydrates via getResizableSnapshot).
    return (
      <PageBody scrollable={false}>
        <ResizablePanelGroup
          orientation="horizontal"
          className="h-full max-h-full"
          autosaveId={autosaveId}
          snapshot={snapshot}
        >
          <ResizablePanel id="metrics-main" min={mainMin}>
            {main}
          </ResizablePanel>
          <ResizableHandle id={`${autosaveId ?? "metrics"}-sidebar-handle`} />
          <ResizablePanel
            id="metrics-sidebar"
            min={min}
            default={defaultSize}
            max={max}
            isStaticAtRest
            className="h-full overflow-hidden"
          >
            {sidebarChildren}
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    );
  }

  // Fixed-width sidebar.
  return (
    <PageBody scrollable={false}>
      <div className="flex h-full w-full overflow-hidden">
        <div className="min-w-0 flex-1">{main}</div>
        <div className="h-full shrink-0 overflow-hidden" style={{ width }}>
          {sidebarChildren}
        </div>
      </div>
    </PageBody>
  );
}

/**
 * The pinned bar under the NavBar. Baked chrome: a 40px-tall bar with a bottom border and the
 * standard page insets. Compose left/right clusters as child divs — `justify-between` spreads them
 * (a single child sits at the start).
 */
function MetricsLayoutFilters({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-grid-dimmed pl-2.5 pr-3">
      {children}
    </div>
  );
}

/** Whether a grid holds stat tiles (auto height) or charts (a fixed row height). */
export type MetricsGridKind = "tiles" | "charts";

/**
 * A grid of tiles with the baked page gutter and grid gap. Columns are derived from the tile count
 * unless you pass an explicit `columns` spec. Pass `kind="charts"` for a row of chart cards — it
 * bakes the fixed chart-row height so the cards fill it (no wrapper needed).
 */
function MetricsLayoutGrid({
  children,
  columns,
  kind = "tiles",
}: {
  children: ReactNode;
  /** Explicit responsive columns. Omit to derive the layout from the number of tiles. */
  columns?: GridColumns;
  /** `"tiles"` (default) sizes to content; `"charts"` bakes the fixed chart-row height. */
  kind?: MetricsGridKind;
}) {
  const resolved = columns ?? columnsForCount(Children.toArray(children).length);
  return (
    <div
      className={cn(
        "grid gap-3 px-3",
        // `shrink-0` is load-bearing: the grid sits in Root's flex-col scroll container, where the
        // default flex-shrink would collapse a fixed-height row whose chart cards have ~no
        // intrinsic height. Pin it so the charts keep their row height and the page scrolls past.
        kind === "charts" && "h-[280px] shrink-0",
        resolved.base && BASE_COLS[resolved.base],
        resolved.sm && SM_COLS[resolved.sm],
        resolved.md && MD_COLS[resolved.md],
        resolved.lg && LG_COLS[resolved.lg]
      )}
    >
      {children}
    </div>
  );
}

/**
 * The content region below the tiles (tabs / table / list). Full-bleed by default so a list table
 * spans edge to edge with its own top border; pass `inset` for a padded column (the detail page's
 * tabs + charts). Either way Content bakes a doubled separation above it, so the tile blocks read
 * as a distinct band from the content below.
 */
function MetricsLayoutContent({
  children,
  inset = false,
}: {
  children: ReactNode;
  /** Pad the content into a column (page gutter) instead of letting it span edge to edge. */
  inset?: boolean;
}) {
  return <div className={cn("mt-3 flex flex-col gap-3", inset && "px-3")}>{children}</div>;
}

export const MetricsLayout = {
  Root: MetricsLayoutRoot,
  Filters: MetricsLayoutFilters,
  Grid: MetricsLayoutGrid,
  Content: MetricsLayoutContent,
  Sidebar: MetricsLayoutSidebar,
};

export {
  MetricsLayoutRoot,
  MetricsLayoutFilters,
  MetricsLayoutGrid,
  MetricsLayoutContent,
  MetricsLayoutSidebar,
};
