import { useState } from "react";
import { PageContainer } from "~/components/layout/AppLayout";
import { MetricsLayout } from "~/components/layout/MetricsLayout";
import { Badge } from "~/components/primitives/Badge";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
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

/**
 * Demonstrates the MetricsLayout compound: a Filters row, count-adaptive Grids (a 4-tile stat
 * grid + a 4-tile chart grid + a 3-tile grid, all with no hand-written grid-cols), and a Content
 * slot that toggles between tabs and a table. The whole page scrolls as one via MetricsLayout.Root.
 */
export default function Story() {
  const [tab, setTab] = useState<"tabs" | "table">("tabs");

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="MetricsLayout" />
      </NavBar>
      <MetricsLayout.Root>
        {/* Filters slot — the row directly under the NavBar. */}
        <MetricsLayout.Filters className="justify-between border-t border-grid-dimmed px-3 pb-3 pt-1.5">
          <div className="flex items-center gap-2">
            <FilterChip>Search…</FilterChip>
            <FilterChip>Period: 7d</FilterChip>
            <Badge variant="extra-small">Filters slot</Badge>
          </div>
          <FilterChip>{"< 1 / 4 >"}</FilterChip>
        </MetricsLayout.Filters>

        {/* Grid slot — 4 stat tiles. Columns are derived from the tile count: two-up, four-up
            from lg. */}
        <div className="px-3 pb-1 pt-2 text-xs uppercase text-text-dimmed">
          Grid — 4 tiles (auto: 2-up, 4-up from lg)
        </div>
        <MetricsLayout.Grid className="px-3 pb-3">
          <StatTile label="Queued" value="83" />
          <StatTile label="Running" value="15" />
          <StatTile label="Allocated" value="29" />
          <StatTile label="Limit" value="25" />
        </MetricsLayout.Grid>

        {/* Grid slot — 4 chart tiles at a fixed row height, same auto columns as the stats. */}
        <div className="px-3 pb-1 text-xs uppercase text-text-dimmed">
          Grid — 4 chart tiles (fixed 280px row)
        </div>
        <div className="h-[280px] px-3 pb-3">
          <MetricsLayout.Grid className="h-full min-h-0">
            <ChartTile label="Env saturation" />
            <ChartTile label="Backlog" />
            <ChartTile label="Scheduling delay p95" />
            <ChartTile label="Throttled" />
          </MetricsLayout.Grid>
        </div>

        {/* Grid slot — 3 tiles. The same component now lays out one-up, three-up from sm, proving
            the grid adapts to the child count. */}
        <div className="px-3 pb-1 text-xs uppercase text-text-dimmed">
          Grid — 3 tiles (auto: 1-up, 3-up from sm)
        </div>
        <MetricsLayout.Grid className="px-3 pb-3">
          <StatTile label="Concurrency" value="11" />
          <StatTile label="Queued" value="83" />
          <StatTile label="Oldest wait" value="34m" />
        </MetricsLayout.Grid>

        {/* Grid slot — explicit columns for a chart grid that should always be two-up regardless
            of tile count. */}
        <div className="px-3 pb-1 text-xs uppercase text-text-dimmed">
          Grid — explicit columns=&#123;&#123; base: 1, sm: 2 &#125;&#125; (5 tiles)
        </div>
        <div className="px-3 pb-3">
          <MetricsLayout.Grid columns={{ base: 1, sm: 2 }}>
            <ChartTile label="Concurrency" className="aspect-[2/1]" />
            <ChartTile label="Queue depth" className="aspect-[2/1]" />
            <ChartTile label="Throughput" className="aspect-[2/1]" />
            <ChartTile label="Scheduling delay" className="aspect-[2/1]" />
            <ChartTile label="Throttled" className="aspect-[2/1]" />
          </MetricsLayout.Grid>
        </div>

        {/* Content slot — tabs vs. table. */}
        <MetricsLayout.Content>
          <TabContainer className="px-3">
            <TabButton
              isActive={tab === "tabs"}
              layoutId="layout-story"
              onClick={() => setTab("tabs")}
            >
              Tabs content
            </TabButton>
            <TabButton
              isActive={tab === "table"}
              layoutId="layout-story"
              onClick={() => setTab("table")}
            >
              Table content
            </TabButton>
          </TabContainer>
          {tab === "table" ? (
            <PlaceholderTable />
          ) : (
            <div className="border-t border-grid-dimmed p-3">
              <Paragraph variant="small">
                The Content slot hosts whatever sits below the tiles — a TabContainer with panels,
                or a full-width table. The whole page (filters, tiles and content) shares one
                vertical scroll.
              </Paragraph>
            </div>
          )}
        </MetricsLayout.Content>
      </MetricsLayout.Root>
    </PageContainer>
  );
}
