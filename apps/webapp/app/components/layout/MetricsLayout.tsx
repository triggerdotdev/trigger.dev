/**
 * MetricsLayout — a compound layout for metric / dashboard pages.
 *
 * Every metrics page reads top-to-bottom as the same three slots:
 *
 *   1. `MetricsLayout.Filters` — the row under the NavBar (search, TimeFilter, pagination…).
 *   2. `MetricsLayout.Grid`    — one or more grids of tiles (stat BigNumbers, chart cards).
 *                                The grid adapts its column count to the number of tiles unless
 *                                you pass an explicit `columns` spec.
 *   3. `MetricsLayout.Content` — the tabs / table / list below the tiles.
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
 *       - `"page"` (default): Root owns a single `overflow-y-auto`; the WHOLE page (filters, tiles
 *         and content) scrolls as one. This is what every current metrics page wants.
 *       - `"regions"`: Root does NOT create a scroll container — it only bounds the height as a
 *         `flex` column. The page composes its own independently-scrolling areas inside the slots
 *         (e.g. a fixed toolbar over a scrolling table, or a vertical resizable split). Use this
 *         when a single page-level scroll would be wrong.
 *
 * The family is purely presentational — slots, grids, a sidebar and scroll ownership only, no data
 * logic. It is meant to live inside a `PageContainer` right after the `NavBar`, mirroring how the
 * `Chart.Root` / `Chart.Line` compound composes.
 *
 * @example List page (self-padded sections, count-derived grids)
 * ```tsx
 * <PageContainer>
 *   <NavBar>…</NavBar>
 *   <MetricsLayout.Root>
 *     <MetricsLayout.Filters className="justify-between border-t border-grid-dimmed px-3 pb-3 pt-1.5">
 *       <div className="flex items-center gap-2">…search + TimeFilter…</div>
 *       <PaginationControls … />
 *     </MetricsLayout.Filters>
 *     <MetricsLayout.Grid className="px-3 pb-3">…4 stat tiles…</MetricsLayout.Grid>
 *     <div className="h-[280px] px-3 pb-3">
 *       <ChartSyncProvider>
 *         <MetricsLayout.Grid className="h-full min-h-0">…4 chart tiles…</MetricsLayout.Grid>
 *       </ChartSyncProvider>
 *     </div>
 *     <MetricsLayout.Content>…table…</MetricsLayout.Content>
 *   </MetricsLayout.Root>
 * </PageContainer>
 * ```
 *
 * @example Detail page (a single padded, gap-4 column)
 * ```tsx
 * <MetricsLayout.Root className="flex flex-col gap-4 p-6">
 *   <MetricsLayout.Filters>…search + TimeFilter…</MetricsLayout.Filters>
 *   <MetricsLayout.Grid className="w-full">…3 stat tiles…</MetricsLayout.Grid>
 *   <MetricsLayout.Content className="flex flex-col gap-4">
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
 *   - `"page"` (default): Root owns one `overflow-y-auto` — the whole page scrolls as one.
 *   - `"regions"`: Root only bounds the height (a `flex` column, no scroll); the page composes its
 *     own scrolling areas inside the slots.
 */
export type MetricsScroll = "page" | "regions";

type MetricsLayoutSidebarProps = {
  children: ReactNode;
  className?: string;
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
 * layout and drops the children into the panel.
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
// sticky without z-index/backdrop bookkeeping). In `"page"` mode the rest scrolls as one; in
// `"regions"` mode the page composes its own scrolling areas.
function MetricsLayoutMain({
  children,
  className,
  scroll,
}: {
  children: ReactNode;
  className?: string;
  scroll: MetricsScroll;
}) {
  const arr = Children.toArray(children);
  const filters = arr.find(isFiltersElement);
  const rest = filters ? arr.filter((child) => !isFiltersElement(child)) : children;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {filters}
      <div
        className={cn(
          scroll === "page"
            ? "min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
            : "flex min-h-0 flex-1 flex-col overflow-hidden",
          className
        )}
      >
        {rest}
      </div>
    </div>
  );
}

function MetricsLayoutRoot({
  children,
  className,
  pageBodyClassName,
  scroll = "page",
}: {
  children: ReactNode;
  /** Applied to the inner scroll container (e.g. `flex flex-col gap-4 p-6` for a single column). */
  className?: string;
  /** Applied to the outer, non-scrolling PageBody wrapper. */
  pageBodyClassName?: string;
  /** Who owns the vertical scroll — see {@link MetricsScroll}. Defaults to `"page"`. */
  scroll?: MetricsScroll;
}) {
  // A single optional Sidebar slot flips Root into a horizontal `[main | sidebar]` layout. When it
  // is absent the output is exactly the original single-column markup (current pages don't pass
  // either new prop, so they render unchanged).
  const sidebar = Children.toArray(children).find(isSidebarElement);
  const mainChildren = sidebar
    ? Children.toArray(children).filter((child) => !isSidebarElement(child))
    : children;

  const main = (
    <MetricsLayoutMain scroll={scroll} className={className}>
      {mainChildren}
    </MetricsLayoutMain>
  );

  if (!sidebar) {
    return (
      <PageBody scrollable={false} className={pageBodyClassName}>
        {/* The whole page scrolls as one: filters, tiles and content share a single vertical scroll
            context, so the tiles scroll out of view with everything else (not an inner content-only
            scroll). */}
        {main}
      </PageBody>
    );
  }

  const {
    children: sidebarChildren,
    className: sidebarClassName,
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
      <PageBody scrollable={false} className={pageBodyClassName}>
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
            className={cn("h-full overflow-hidden", sidebarClassName)}
          >
            {sidebarChildren}
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    );
  }

  // Fixed-width sidebar.
  return (
    <PageBody scrollable={false} className={pageBodyClassName}>
      <div className="flex h-full w-full overflow-hidden">
        <div className="min-w-0 flex-1">{main}</div>
        <div className={cn("h-full shrink-0 overflow-hidden", sidebarClassName)} style={{ width }}>
          {sidebarChildren}
        </div>
      </div>
    </PageBody>
  );
}

function MetricsLayoutFilters({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("flex shrink-0 items-center gap-2", className)}>{children}</div>;
}

function MetricsLayoutGrid({
  children,
  columns,
  className,
}: {
  children: ReactNode;
  /** Explicit responsive columns. Omit to derive the layout from the number of tiles. */
  columns?: GridColumns;
  className?: string;
}) {
  const resolved = columns ?? columnsForCount(Children.toArray(children).length);
  return (
    <div
      className={cn(
        "grid gap-3",
        resolved.base && BASE_COLS[resolved.base],
        resolved.sm && SM_COLS[resolved.sm],
        resolved.md && MD_COLS[resolved.md],
        resolved.lg && LG_COLS[resolved.lg],
        className
      )}
    >
      {children}
    </div>
  );
}

function MetricsLayoutContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={className}>{children}</div>;
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
