import { ComponentNames } from "../storybook/StoryKit";
import { useState } from "react";
import { PageContainer } from "~/components/layout/AppLayout";
import { MetricsLayout } from "~/components/layout/MetricsLayout";
import { Badge } from "~/components/primitives/Badge";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { cn } from "~/utils/cn";

// A placeholder for a search input / TimeFilter / pagination — the real pages drop live controls
// into the Filters slot; here we only show the row shape.
function FilterChip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-1.5 rounded-sm border border-grid-dimmed bg-background-bright px-3 text-sm text-text-dimmed">
      {children}
    </div>
  );
}

// A stat BigNumber-style tile.
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-grid-dimmed bg-background-bright p-4">
      <Header3 className="leading-6">{label}</Header3>
      <div className="mt-2 text-[3rem] font-normal leading-none tabular-nums text-text-bright">
        {value}
      </div>
    </div>
  );
}

// A chart-card-style tile with a fake bar sparkline so the grid's height + column behaviour is
// visible.
function ChartTile({ label, className }: { label: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-sm border border-grid-dimmed bg-background-bright p-3",
        className
      )}
    >
      <Paragraph variant="small/bright">{label}</Paragraph>
      <div className="mt-3 flex min-h-0 flex-1 items-end gap-px">
        {Array.from({ length: 40 }).map((_, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-[1px] bg-primary/60"
            style={{ height: `${20 + Math.abs(Math.sin(i / 3)) * 70}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function PlaceholderTable() {
  return (
    <Table containerClassName="border-t">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell alignment="right">Queued</TableHeaderCell>
          <TableHeaderCell alignment="right">Running</TableHeaderCell>
          <TableHeaderCell alignment="right">Limit</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[
          { name: "background", queued: 0, running: 4, limit: 19 },
          { name: "per-tenant", queued: 83, running: 11, limit: 10 },
          { name: "emails", queued: 2, running: 1, limit: 50 },
        ].map((row) => (
          <TableRow key={row.name}>
            <TableCell>{row.name}</TableCell>
            <TableCell alignment="right">{row.queued}</TableCell>
            <TableCell alignment="right">{row.running}</TableCell>
            <TableCell alignment="right">{row.limit}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// A tall filler so a scroll region visibly overflows its container.
function ScrollFiller({ label, rows }: { label: string; rows: number }) {
  return (
    <div className="flex flex-col gap-2 p-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded-sm border border-grid-dimmed bg-background-bright px-3 py-2 text-sm text-text-dimmed"
        >
          <span>
            {label} row {i + 1}
          </span>
          <span className="tabular-nums">{Math.round(Math.abs(Math.sin(i)) * 1000)}</span>
        </div>
      ))}
    </div>
  );
}

// The config panel dropped into MetricsLayout.Sidebar in the sidebar demos.
function SidebarPanel({ resizable }: { resizable?: boolean }) {
  return (
    <div className="flex h-full flex-col border-l border-grid-dimmed bg-background-bright">
      <div className="flex h-10 shrink-0 items-center border-b border-grid-dimmed px-3">
        <Header3>Sidebar slot</Header3>
      </div>
      <div className="flex flex-col gap-3 overflow-y-auto p-3">
        <Paragraph variant="small">
          {resizable
            ? "This sidebar is resizable — drag the handle on its left edge. Pass an autosaveId + a loader snapshot to persist the split across reloads."
            : "This sidebar is fixed-width (width prop). The main column fills the rest and owns the page scroll."}
        </Paragraph>
        <Badge variant="extra-small">{resizable ? "resizable" : "fixed width"}</Badge>
        {Array.from({ length: 6 }).map((_, i) => (
          <FilterChip key={i}>Config option {i + 1}</FilterChip>
        ))}
      </div>
    </div>
  );
}

// The overview demo. Every slot carries its baked chrome — no className is passed to Root,
// Filters, Grid or Content. The pinned Filters bar spreads a left and right cluster; the Grids
// bake the page gutter and adapt their columns (or take an explicit `columns` / `kind="charts"`);
// Content toggles between a full-bleed table and an inset panel. The whole page scrolls as one.
function OverviewDemo() {
  const [tab, setTab] = useState<"panel" | "table">("panel");

  return (
    <MetricsLayout.Root>
      {/* Filters slot — the pinned bar directly under the NavBar. Left + right clusters as child
          divs; the slot bakes the 40px height, border and insets. */}
      <MetricsLayout.Filters>
        <div className="flex items-center gap-2">
          <FilterChip>Search…</FilterChip>
          <FilterChip>Period: 7d</FilterChip>
          <Badge variant="extra-small">Filters slot</Badge>
        </div>
        <FilterChip>{"< 1 / 4 >"}</FilterChip>
      </MetricsLayout.Filters>

      {/* Grid slot — 4 stat tiles. Columns are derived from the tile count: two-up, four-up
            from lg. The gutter + gap are baked. */}
      <div className="px-3 text-xs uppercase text-text-dimmed">
        Grid — 4 tiles (auto: 2-up, 4-up from lg)
      </div>
      <MetricsLayout.Grid>
        <StatTile label="Queued" value="83" />
        <StatTile label="Running" value="15" />
        <StatTile label="Allocated" value="29" />
        <StatTile label="Limit" value="25" />
      </MetricsLayout.Grid>

      {/* Grid slot — kind="charts" bakes the fixed chart-row height (no wrapper needed). */}
      <div className="px-3 text-xs uppercase text-text-dimmed">
        Grid — kind=&quot;charts&quot; (fixed row height, auto columns)
      </div>
      <MetricsLayout.Grid kind="charts">
        <ChartTile label="Env saturation" />
        <ChartTile label="Backlog" />
        <ChartTile label="Scheduling delay p95" />
        <ChartTile label="Throttled" />
      </MetricsLayout.Grid>

      {/* Grid slot — 3 tiles. The same component lays out one-up, three-up from sm, proving the
            grid adapts to the child count. */}
      <div className="px-3 text-xs uppercase text-text-dimmed">
        Grid — 3 tiles (auto: 1-up, 3-up from sm)
      </div>
      <MetricsLayout.Grid>
        <StatTile label="Concurrency" value="11" />
        <StatTile label="Queued" value="83" />
        <StatTile label="Oldest wait" value="34m" />
      </MetricsLayout.Grid>

      {/* Grid slot — explicit columns for a chart grid that should always be two-up regardless
            of tile count. */}
      <div className="px-3 text-xs uppercase text-text-dimmed">
        Grid — explicit columns=&#123;&#123; base: 1, sm: 2 &#125;&#125; (5 tiles)
      </div>
      <MetricsLayout.Grid columns={{ base: 1, sm: 2 }}>
        <ChartTile label="Concurrency" className="aspect-[2/1]" />
        <ChartTile label="Queue depth" className="aspect-[2/1]" />
        <ChartTile label="Throughput" className="aspect-[2/1]" />
        <ChartTile label="Scheduling delay" className="aspect-[2/1]" />
        <ChartTile label="Throttled" className="aspect-[2/1]" />
      </MetricsLayout.Grid>

      {/* Content slot — a doubled separation above it is baked in, so the tiles read as their own
          band. `inset` toggles between a padded column (panel) and full-bleed (edge-to-edge
          table). */}
      <MetricsLayout.Content inset={tab === "panel"}>
        <TabContainer>
          <TabButton
            isActive={tab === "panel"}
            layoutId="layout-story"
            onClick={() => setTab("panel")}
          >
            Panel (inset)
          </TabButton>
          <TabButton
            isActive={tab === "table"}
            layoutId="layout-story"
            onClick={() => setTab("table")}
          >
            Table (full-bleed)
          </TabButton>
        </TabContainer>
        {tab === "table" ? (
          <PlaceholderTable />
        ) : (
          <div className="rounded-sm border border-grid-dimmed bg-background-bright p-3">
            <Paragraph variant="small">
              With <code>inset</code>, Content becomes a padded column: this panel and the tabs
              above it sit on the standard page gutter. Switch to the table to see Content go
              full-bleed — the table spans edge to edge with its own top border. Either way the
              whole page (filters aside) shares one vertical scroll.
            </Paragraph>
          </div>
        )}
      </MetricsLayout.Content>
    </MetricsLayout.Root>
  );
}

// Fixed-width sidebar: a <MetricsLayout.Sidebar> child flips Root into a [main | sidebar] layout.
// The main column keeps its normal top-to-bottom slots and owns the page scroll.
function SidebarFixedDemo() {
  return (
    <MetricsLayout.Root>
      <MetricsLayout.Filters>
        <div className="flex items-center gap-2">
          <FilterChip>Search…</FilterChip>
          <Badge variant="extra-small">main column</Badge>
        </div>
      </MetricsLayout.Filters>
      <MetricsLayout.Grid>
        <StatTile label="Queued" value="83" />
        <StatTile label="Running" value="15" />
        <StatTile label="Allocated" value="29" />
      </MetricsLayout.Grid>
      <MetricsLayout.Content>
        <PlaceholderTable />
      </MetricsLayout.Content>

      <MetricsLayout.Sidebar width="320px">
        <SidebarPanel />
      </MetricsLayout.Sidebar>
    </MetricsLayout.Root>
  );
}

// Resizable sidebar: same [main | sidebar] layout, but the split is draggable via the shared
// Resizable primitives. autosaveId persists the split to a cookie (in a real page the loader
// hydrates it back through a snapshot); here it persists live within the session.
function SidebarResizableDemo() {
  return (
    <MetricsLayout.Root>
      <MetricsLayout.Filters>
        <div className="flex items-center gap-2">
          <FilterChip>Search…</FilterChip>
          <Badge variant="extra-small">drag the handle →</Badge>
        </div>
      </MetricsLayout.Filters>
      <MetricsLayout.Grid>
        <StatTile label="Queued" value="83" />
        <StatTile label="Running" value="15" />
        <StatTile label="Allocated" value="29" />
      </MetricsLayout.Grid>
      <MetricsLayout.Content>
        <PlaceholderTable />
      </MetricsLayout.Content>

      <MetricsLayout.Sidebar
        resizable
        autosaveId="storybook-metrics-sidebar"
        min="260px"
        defaultSize="360px"
        max="520px"
      >
        <SidebarPanel resizable />
      </MetricsLayout.Sidebar>
    </MetricsLayout.Root>
  );
}

// scroll="regions": Root does NOT create the page scroll. It only bounds the height as a flex
// column, so the page composes its own independently-scrolling areas — here a fixed toolbar over
// two side-by-side lists that each scroll on their own.
function RegionsDemo() {
  return (
    <MetricsLayout.Root scroll="regions">
      <div className="flex h-10 shrink-0 items-center gap-2 border-t border-grid-dimmed px-3">
        <Badge variant="extra-small">fixed toolbar (does not scroll)</Badge>
        <FilterChip>Period: 7d</FilterChip>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-grid-dimmed">
        <div className="min-h-0 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
          <div className="sticky top-0 z-1 border-b border-grid-dimmed bg-background px-3 py-1.5 text-xs uppercase text-text-dimmed">
            Left region — scrolls independently
          </div>
          <ScrollFiller label="Left" rows={60} />
        </div>
        <div className="min-h-0 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
          <div className="sticky top-0 z-1 border-b border-grid-dimmed bg-background px-3 py-1.5 text-xs uppercase text-text-dimmed">
            Right region — scrolls independently
          </div>
          <ScrollFiller label="Right" rows={60} />
        </div>
      </div>
    </MetricsLayout.Root>
  );
}

type Demo = "overview" | "sidebar-fixed" | "sidebar-resizable" | "regions";

const DEMO_OPTIONS: { label: string; value: Demo }[] = [
  { label: "Overview", value: "overview" },
  { label: "Sidebar (fixed)", value: "sidebar-fixed" },
  { label: "Sidebar (resizable)", value: "sidebar-resizable" },
  { label: "Scroll: regions", value: "regions" },
];

/**
 * Storybook for the MetricsLayout compound. A segmented control swaps between demos, each filling
 * the page:
 *   - Overview            — the base Filters / count-adaptive Grid / Content slots, page scroll.
 *   - Sidebar (fixed)     — a fixed-width MetricsLayout.Sidebar beside the main column.
 *   - Sidebar (resizable) — the same, but with a draggable split (autosaveId persistence).
 *   - Scroll: regions     — scroll="regions" with two independently-scrolling areas.
 */
export default function Story() {
  const [demo, setDemo] = useState<Demo>("overview");

  return (
    <PageContainer>
      <div className="px-4 pt-4">
        <ComponentNames names={["AppLayout.tsx", "PageHeader.tsx"]} />
      </div>
      <NavBar>
        <PageTitle title="MetricsLayout" />
        <PageAccessories>
          <SegmentedControl
            name="metrics-layout-demo"
            value={demo}
            options={DEMO_OPTIONS}
            onChange={(value) => setDemo(value as Demo)}
          />
        </PageAccessories>
      </NavBar>
      {demo === "overview" ? (
        <OverviewDemo />
      ) : demo === "sidebar-fixed" ? (
        <SidebarFixedDemo />
      ) : demo === "sidebar-resizable" ? (
        <SidebarResizableDemo />
      ) : (
        <RegionsDemo />
      )}
    </PageContainer>
  );
}
