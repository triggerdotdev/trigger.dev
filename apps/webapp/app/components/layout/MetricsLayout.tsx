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
 * `MetricsLayout.Root` owns the single, page-level scroll: the WHOLE page (filters, tiles and
 * content) scrolls as one, rather than an inner table-only scroll.
 *
 * The family is purely presentational — slots, grids and scroll only, no data logic. It is meant
 * to live inside a `PageContainer` right after the `NavBar`, mirroring how the `Chart.Root` /
 * `Chart.Line` compound composes.
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
 */
import { Children, type ReactNode } from "react";
import { PageBody } from "~/components/layout/AppLayout";
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

function MetricsLayoutRoot({
  children,
  className,
  pageBodyClassName,
}: {
  children: ReactNode;
  /** Applied to the inner scroll container (e.g. `flex flex-col gap-4 p-6` for a single column). */
  className?: string;
  /** Applied to the outer, non-scrolling PageBody wrapper. */
  pageBodyClassName?: string;
}) {
  return (
    <PageBody scrollable={false} className={pageBodyClassName}>
      {/* The whole page scrolls as one: filters, tiles and content share a single vertical scroll
          context, so the tiles scroll out of view with everything else (not an inner content-only
          scroll). */}
      <div
        className={cn(
          "h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control",
          className
        )}
      >
        {children}
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
  return <div className={cn("flex items-center gap-2", className)}>{children}</div>;
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
};

export { MetricsLayoutRoot, MetricsLayoutFilters, MetricsLayoutGrid, MetricsLayoutContent };
