/**
 * MetricsLayout — a compound layout for metric / dashboard pages.
 *
 * Slots bake all the chrome; there is no `className` on any slot, so pages can't drift apart on
 * spacing. Need a variant? Add a closed prop (`kind`, `inset`), don't reopen `className`.
 *
 * Slots, top to bottom:
 *   - `Filters` — pinned 40px bar under the NavBar. Left/right clusters are child divs.
 *   - `Grid` — tiles; columns derived from tile count unless `columns` is set. `kind="charts"`
 *     bakes the fixed chart-row height.
 *   - `Content` — table / tabs below the tiles. Full-bleed by default; `inset` for a padded column.
 *
 * Optional:
 *   - `Sidebar` — a persistent right-hand panel; fixed `width` or `resizable`. Present ⇒ Root
 *     switches to `[main | sidebar]`; absent ⇒ single column.
 *   - `scroll` on Root — `"page"` (default): the whole page scrolls as one. `"regions"`: Root owns
 *     no scroll, the page composes its own scrolling areas.
 *
 * Purely presentational. Lives inside a `PageContainer` after the `NavBar`.
 *
 * @example
 * ```tsx
 * <MetricsLayout.Root>
 *   <MetricsLayout.Filters>
 *     <div className="flex items-center gap-2">…search + TimeFilter…</div>
 *     <PaginationControls … />
 *   </MetricsLayout.Filters>
 *   <MetricsLayout.Grid>…stat tiles…</MetricsLayout.Grid>
 *   <MetricsLayout.Grid kind="charts">…chart tiles…</MetricsLayout.Grid>
 *   <MetricsLayout.Content>…table…</MetricsLayout.Content>
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
type GridColumns = {
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
type MetricsScroll = "page" | "regions";

/** A length the resizable panels accept: pixels or percent (the panel library's `Unit`). */
type PanelLength = `${number}px` | `${number}%`;

type MetricsLayoutSidebarProps = {
  children: ReactNode;
  /**
   * Fixed sidebar width for the non-resizable default (any CSS length, e.g. `"380px"`, `"22rem"`).
   * Ignored when `resizable` is set. Defaults to `"380px"`.
   */
  width?: string;
  /**
   * Makes the split draggable. To persist it, pass an `autosaveId` (written to a cookie) plus the
   * `snapshot` read back in the loader via `getResizableSnapshot(request, autosaveId)`.
   */
  resizable?: boolean;
  /** Resizable only: min width of the sidebar panel. Defaults to `"280px"`. */
  min?: PanelLength;
  /** Resizable only: initial width of the sidebar panel. Defaults to `"380px"`. */
  defaultSize?: PanelLength;
  /** Resizable only: max width of the sidebar panel. */
  max?: PanelLength;
  /** Resizable only: min width of the main panel. Defaults to `"300px"`. */
  mainMin?: PanelLength;
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

// The main (left) column. Filters is hoisted out of the scroll container so it stays pinned while
// the rest scrolls. `"page"` scrolls as one with the baked column rhythm; `"regions"` stays bare so
// the page owns its own scrolling.
function MetricsLayoutMain({ children, scroll }: { children: ReactNode; scroll: MetricsScroll }) {
  const arr = Children.toArray(children);
  const filters = arr.find(isFiltersElement);
  const rest = filters ? arr.filter((child) => !isFiltersElement(child)) : children;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {filters}
      {/* overflow-x-clip: without it `overflow-y-auto` promotes x to auto and wide content drags
          the charts sideways. Wide children must scroll in their own container. */}
      <div
        className={
          scroll === "page"
            ? "flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overflow-x-clip py-2.5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
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
function MetricsLayoutFilters({
  children,
  className,
}: {
  children: ReactNode;
  /** Override the baked horizontal padding (the two queue pages want slightly different insets). */
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center justify-between gap-2 border-b border-grid-dimmed px-2",
        className
      )}
    >
      {children}
    </div>
  );
}

/** Whether a grid holds stat tiles (auto height) or charts (a fixed row height). */
type MetricsGridKind = "tiles" | "charts";

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
        "grid gap-2.5 px-2.5",
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
 * tabs + charts). Separation from the tiles above comes from the scroll column's gap alone (no
 * extra top margin), so the tile → content step matches the gap between tile rows.
 */
function MetricsLayoutContent({
  children,
  inset = false,
}: {
  children: ReactNode;
  /** Pad the content into a column (page gutter) instead of letting it span edge to edge. */
  inset?: boolean;
}) {
  return <div className={cn("flex flex-col gap-2.5", inset && "px-2.5")}>{children}</div>;
}

export const MetricsLayout = {
  Root: MetricsLayoutRoot,
  Filters: MetricsLayoutFilters,
  Grid: MetricsLayoutGrid,
  Content: MetricsLayoutContent,
  Sidebar: MetricsLayoutSidebar,
};
