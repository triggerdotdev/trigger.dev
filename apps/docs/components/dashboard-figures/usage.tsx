// The organization's Usage page for the current month on a paid plan with a $100 billing limit, at
// a 1000px page width (the settings side menu left out): the month-to-date total against the
// included usage, the Usage by day chart and the Tasks table. Drawn from source with made-up data:
// the local dashboard has no billing. The webapp files it mirrors are its `sources` in
// lib/dashboard-figures.ts.
import { ChevronDown } from "lucide-react";
import { Button, PageHeader, tableHeader, tableRow, th } from "./chrome";
import { Chart } from "./chart-parts";

// November 1 to 25 (month-to-date), in dollars; the rest of the month has no usage yet.
const daily = [
  0.82, 1.06, 1.31, 1.38, 0.94, 0.41, 0.38, 1.12, 1.35, 1.29, 1.33, 1.27, 0.46, 0.39, 1.18, 1.41,
  1.36, 1.3, 1.25, 0.52, 0.44, 1.21, 1.39, 1.34, 0.71,
];
const days = Array.from({ length: 30 }, (_, i) => daily[i] ?? 0);
const total = daily.reduce((s, v) => s + v, 0);
const money = (v: number) => `$${v.toFixed(2)}`;

// Sorted by total cost, as the page lists them; the costs add up to the month-to-date total.
const tasks = [
  ["process-image", "6,412", "58.6s", "$0.00139459", "4d, 8h", "$8.94210732"],
  ["generate-report", "1,206", "3m, 4.3s", "$0.00507333", "2d, 13h", "$6.11843504"],
  ["sync-data", "48,215", "2.9s", "$0.00008867", "1d, 14h", "$4.27519088"],
  ["send-email", "131,870", "1.1s", "$0.00002356", "1d, 16h", "$3.10672348"],
  ["hello-world", "3,408", "7.4s", "$0.00059914", "7h", "$2.04186211"],
  ["cleanup-uploads", "1,552", "22.8s", "$0.00073175", "9h, 49m", "$1.13568117"],
];
const columns = [
  "Task",
  "Runs",
  "Average duration",
  "Average cost",
  "Total duration",
  "Total cost",
];

// UsageBar.tsx: the bar runs to 110% of the largest amount (here the $100.00 billing limit).
const INCLUDED = 50;
const LIMIT = 100;
const range = Math.round(Math.max(total, INCLUDED, LIMIT, 5) * 1.1);
const usedPct = Math.round((total / range) * 100);
const includedPct = Math.round((INCLUDED / range) * 100);
const limitPct = Math.round((LIMIT / range) * 100);

// UsageBar's Legend positions.
const positions = {
  topRow1: "bottom-0 h-9",
  bottomRow1: "top-0 h-9 items-end",
  bottomRow2: "top-0 h-14 items-end",
};

/** UsageBar's Legend: a label on a 1px line at the end of its segment, flipped past 80%. */
function BarLegend({
  text,
  value,
  pct,
  position,
  mark,
}: {
  text: string;
  value: string;
  pct: number;
  position: keyof typeof positions;
  mark?: string;
}) {
  return (
    <div
      data-mark={mark}
      data-mark-badge={mark ? "left" : undefined}
      className={`absolute left-full z-10 flex border-border-brightest ${positions[position]} ${pct > 80 ? "-translate-x-full border-r" : "border-l"}`}
    >
      <div className="font-sans font-medium mr-px h-fit whitespace-nowrap bg-background-bright px-1.5 text-xs text-text-bright">
        {text}
        <span className="ml-1 text-text-dimmed">{value}</span>
      </div>
    </div>
  );
}

// Table.tsx, "dimmed" variant. align-middle: a real <td> is vertically centered by default.
const td = "table-cell align-middle text-xs text-text-dimmed px-3 py-3";

export function UsageFigure() {
  // The chart fills its card: the page width less the grid gutters, the border and Card.Content's px-2.
  const chartWidth = 1000 - 20 - 2 - 16;

  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-dimmed">
      <PageHeader title="Usage" />
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-grid-dimmed px-2">
          <div className="flex items-center gap-2">
            <div
              data-mark="month"
              className="flex items-center gap-1 h-6 rounded text-xs px-2 bg-tertiary border border-tertiary text-text-bright"
            >
              <div className="flex min-w-0 grow items-center gap-0.5 overflow-hidden">
                <div className="min-w-0 truncate">November 2026</div>
              </div>
              <ChevronDown className="size-4 flex-none text-text-dimmed" />
            </div>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden py-2.5">
          <div className="grid gap-2.5 px-2.5 grid-cols-1">
            <div
              data-mark="month-to-date"
              className="flex flex-col rounded-lg border border-grid-bright bg-background-bright pt-3 pb-4"
            >
              <div className="pl-4 pr-4">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-baseline gap-2">
                      <div className="whitespace-nowrap text-3xl font-medium text-text-bright">
                        {money(total)}
                      </div>
                      <div className="font-sans text-base leading-6 font-semibold tracking-tight text-text-bright whitespace-nowrap">
                        month-to-date
                      </div>
                    </div>
                    <Button variant="secondary" mark="update-limit" markBadge="left">
                      Update billing limit
                    </Button>
                  </div>
                  <div className="h-fit w-full pt-6 pb-12">
                    <div className="relative h-3 w-full rounded-sm bg-background-bright">
                      <div style={{ width: `${limitPct}%` }} className="absolute h-3 rounded-l-sm">
                        <BarLegend
                          text="Billing limit:"
                          value={money(LIMIT)}
                          pct={limitPct}
                          position="bottomRow2"
                          mark="limit-marker"
                        />
                      </div>
                      <div
                        style={{ width: `${usedPct}%` }}
                        className="absolute h-3 rounded-l-sm bg-green-600"
                      >
                        <BarLegend
                          text="Used:"
                          value={money(total)}
                          pct={usedPct}
                          position="topRow1"
                        />
                      </div>
                      <div
                        style={{ width: `${includedPct}%` }}
                        className="absolute h-3 rounded-l-sm bg-green-900/20"
                      >
                        <BarLegend
                          text="Included usage:"
                          value={money(INCLUDED)}
                          pct={includedPct}
                          position="bottomRow1"
                        />
                      </div>
                      <div
                        style={{ width: `${Math.min(usedPct, includedPct)}%` }}
                        className="absolute h-3 rounded-l-sm bg-green-600"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="grid gap-2.5 px-2.5 grid-cols-1">
            <div
              data-mark="usage-by-day"
              className="flex flex-col rounded-lg border border-grid-bright bg-background-bright pb-1.5 pt-3"
            >
              <div className="font-sans text-sm leading-5 font-semibold text-text-bright mb-3 flex items-start justify-between gap-2 pl-4 pr-3">
                Usage by day
              </div>
              <div className="px-2">
                <Chart
                  kind="bar"
                  width={chartWidth}
                  height={320}
                  yTicks={[0, 0.4, 0.8, 1.2, 1.6]}
                  yFormat={money}
                  maxLabel={money(Math.max(...daily))}
                  xLabels={days.map((_, i) => `${i + 1}`)}
                  series={[{ key: "dollars", label: "Usage $", color: "#7655fd", values: days }]}
                  angled={false}
                />
              </div>
            </div>
          </div>
          <div data-mark="tasks" className="flex flex-col gap-2.5">
            <div className="mt-2.5 flex items-baseline justify-between gap-2 pl-3 pr-3">
              <div className="font-sans text-base leading-6 font-semibold tracking-tight text-text-bright">
                Tasks
              </div>
              <div className="font-sans text-xs font-medium text-right text-text-dimmed">
                Dev environment runs are excluded from the usage data above, since they do not have
                an associated compute cost.
              </div>
            </div>
            <div className="whitespace-nowrap overflow-hidden border-t">
              <div className="table w-full">
                <div className={tableHeader}>
                  <div className={tableRow}>
                    {columns.map((c, i) => (
                      <div key={c} className={`${th} ${i ? "text-right" : "text-left"}`}>
                        {c}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="table-row-group relative">
                  {tasks.map((t) => (
                    <div key={t[0]} className={tableRow}>
                      {t.map((cell, i) => (
                        <div
                          key={i}
                          className={`${td} ${i ? "text-right tabular-nums" : "text-left"}`}
                        >
                          {cell}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
