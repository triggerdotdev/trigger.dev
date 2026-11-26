// The built-in Run metrics dashboard in Production at a 1000px page width: the filter bar, the four
// big-number widgets and the two charts below them. The page structure is captured from the live
// dashboard (empty there); the chart data is made up, and the charts are static SVG laid out the
// way the webapp's recharts setup draws them. The webapp files it mirrors are its `sources` in
// lib/dashboard-figures.ts.
import type { ReactNode } from "react";
import { Chart, compact, Legend, legendHeight, type Series } from "./chart-parts";
import { Button, PageHeader } from "./chrome";
import * as I from "./icons";

// ---- Data: 25 hourly buckets from Nov 24 11:00, made up ----

const hours = Array.from({ length: 25 }, (_, i) => {
  const h = (11 + i) % 24;
  return `Nov ${i < 13 ? 24 : 25} ${String(h).padStart(2, "0")}:00`;
});
const totals = [
  412, 820, 805, 812, 798, 790, 776, 640, 612, 655, 1240, 830, 815, 822, 809, 801, 794, 802, 811,
  470, 760, 818, 826, 834, 712,
];
const failedPct = [
  8.7, 10.1, 9.8, 9.6, 10.2, 9.9, 9.4, 10.6, 11.3, 9.2, 8.4, 9.7, 9.9, 10.1, 9.5, 9.8, 9.6, 10.3,
  9.9, 12.1, 10.4, 9.7, 9.8, 9.6, 10.2,
];
const share = (pct: number) => totals.map((t) => Math.round((t * pct) / 100));
const failed = totals.map((t, i) => Math.round((t * failedPct[i]) / 100));
const timedOut = share(1.5);
const canceled = share(1.2);
const expired = share(0.25);
const crashed = totals.map((_, i) => (i % 9 === 4 ? 1 : 0));
const systemFailure = totals.map((_, i) => (i % 11 === 7 ? 1 : 0));
const completed = totals.map(
  (t, i) => t - failed[i] - timedOut[i] - canceled[i] - expired[i] - crashed[i] - systemFailure[i]
);
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const avg = (a: number[]) => sum(a) / a.length;
const fmt = (v: number) => v.toLocaleString("en-US");
const sig3 = (v: number) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));

const statuses: Series[] = [
  {
    key: "c",
    label: "Completed",
    color: "var(--color-run-completed-successfully)",
    values: completed,
  },
  { key: "f", label: "Failed", color: "var(--color-run-completed-with-errors)", values: failed },
  { key: "t", label: "Timed out", color: "var(--color-run-timed-out)", values: timedOut },
  { key: "x", label: "Canceled", color: "var(--color-run-canceled)", values: canceled },
  { key: "e", label: "Expired", color: "var(--color-run-expired)", values: expired },
  { key: "k", label: "Crashed", color: "var(--color-run-crashed)", values: crashed },
  {
    key: "s",
    label: "System failure",
    color: "var(--color-run-system-failure)",
    values: systemFailure,
  },
];
const percent = (a: number[]) => a.map((v, i) => (v / totals[i]) * 100);
// Run success %: yAxisColumns ["failed", "completed"]; completed takes series color 1 (green).
const success: Series[] = [
  { key: "completed", label: "completed", color: "#22c55e", values: percent(completed) },
  { key: "failed", label: "failed", color: "#f43f5e", values: percent(failed) },
];

// ---- Layout: react-grid-layout, 12 columns, 30px rows, 10px margins, at a 1000px page ----

const PAGE = 1000;
const col = (PAGE - 10 * 13) / 12;
const box = (x: number, yRow: number, w: number, h: number) => ({
  left: 10 + x * (col + 10),
  top: 10 + yRow * 40,
  width: w * col + (w - 1) * 10,
  height: h * 30 + (h - 1) * 10,
});
/** The tile's content height: border, pt-3, the 24px header row, mb-3 and the 1px divider. */
const contentHeight = (h: number) => h - 2 - 12 - 24 - 12 - 1;

function Tile({
  title,
  mark,
  at,
  children,
}: {
  title: string;
  mark?: string;
  at: ReturnType<typeof box>;
  children: ReactNode;
}) {
  // A mark on the right-hand column puts its badge on the left, inside the canvas.
  return (
    <div
      data-mark={mark}
      data-mark-badge={mark && at.left > 10 ? "left" : undefined}
      className="absolute"
      style={at}
    >
      <div className="flex flex-col rounded-lg border border-grid-bright bg-background-bright pt-3 h-full overflow-hidden px-0 pb-0">
        <div className="font-sans text-sm leading-5 font-semibold text-text-bright mb-3 flex items-start justify-between gap-2 pl-4 pr-3">
          <div className="flex items-center gap-1.5">{title}</div>
          {/* The widget's menu buttons, hidden until hover. */}
          <div className="size-6" />
        </div>
        <div className="relative h-px w-full overflow-hidden bg-transparent" />
        <div className="min-h-0 flex-1 overflow-hidden p-0">{children}</div>
      </div>
    </div>
  );
}

function BigNumber({ value, suffix }: { value: string; suffix?: string }) {
  return (
    <div className="h-full w-full @container-size">
      <div className="grid h-full w-full place-items-center">
        <div className="flex items-baseline gap-[0.15em] whitespace-nowrap text-[clamp(24px,12cqw,96px)] font-normal tabular-nums leading-none text-text-bright">
          <span>{value}</span>
          {suffix && <span className="text-[0.4em] text-text-dimmed">{suffix}</span>}
        </div>
      </div>
    </div>
  );
}

const filterButton =
  "flex items-center gap-1 h-6 rounded text-xs px-2 bg-secondary border border-border-bright/50 shadow-xs text-text-bright pl-1.5";
const filterPill =
  "flex items-center h-6 bg-secondary rounded pl-1.5 gap-1.5 text-xs divide-x divide-black/15 shadow-xs text-text-bright border border-border-bright/50 pr-2";

function FilterButton({ icon, label, mark }: { icon: ReactNode; label: string; mark: string }) {
  return (
    <div data-mark={mark} className={filterButton}>
      <div className="flex min-w-0 grow items-center gap-0.5 overflow-hidden">
        <div className="flex-none">{icon}</div>
        <div className="min-w-0 truncate">
          <span className="ml-1">{label}</span>
        </div>
      </div>
    </div>
  );
}

export function MetricsDashboardFigure() {
  const charts = box(0, 4, 6, 13);
  const chartWidth = charts.width - 2;
  const chartBody = contentHeight(charts.height);
  const total = sum(totals);
  const legendRows = statuses.slice(0, 5);

  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-dimmed">
      <PageHeader title="Run metrics" />
      <div className="grid grid-rows-[auto_1fr] overflow-hidden">
        <div className="flex items-center justify-between gap-x-2 border-b border-b-grid-bright py-2 pl-2 pr-3">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <div data-mark="scope" className={filterPill}>
              <div className="flex items-start leading-4 gap-0.5">
                <div className="mt-[-0.5px] flex items-center gap-1.5">
                  <div className="text-text-bright">
                    <span>Scope</span>:
                  </div>
                </div>
                <div className="text-text-dimmed">
                  <span className="flex items-center gap-1">
                    <svg className="text-prod size-4" viewBox="0 0 20 20" fill="none">
                      <circle cx="10" cy="10" r="2" fill="currentColor" />
                      <path
                        d="M7 3H5C3.89543 3 3 3.89543 3 5V7M17 7L17 5C17 3.89543 16.1046 3 15 3L13 3M13 17L15 17C16.1046 17 17 16.1046 17 15L17 13M3 13L3 15C3 16.1046 3.89543 17 5 17L7 17"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="truncate text-left system-mono-label text-prod">
                      Production
                    </span>
                  </span>
                </div>
              </div>
            </div>
            <FilterButton mark="tasks" label="Tasks" icon={<I.TasksIcon className="size-4" />} />
            <FilterButton
              mark="queues"
              label="Queues"
              icon={<I.RectangleStackIcon className="size-4" />}
            />
            <div data-mark="period" className={filterPill}>
              <div className="flex items-start leading-4 gap-1.5">
                <div className="mt-[-0.5px] flex items-center gap-1.5">
                  <I.CalendarIcon className="size-4" />
                </div>
                <div className="text-text-bright">1 day</div>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center">
            <Button
              variant="primary"
              icon={I.PlusIcon}
              shortcut="n"
              className="pr-2"
              mark="create"
              markBadge="left"
            >
              Create custom dashboard
            </Button>
          </div>
        </div>
        <div className="relative overflow-hidden">
          <div
            data-mark="big-numbers"
            data-mark-badge="below"
            className="absolute"
            style={box(0, 0, 12, 4)}
          />
          <Tile title="Success %" at={box(0, 0, 3, 4)}>
            <BigNumber value={((sum(completed) / total) * 100).toFixed(1)} suffix="%" />
          </Tile>
          <Tile title="Total runs" at={box(3, 0, 3, 4)}>
            <BigNumber value={fmt(total)} />
          </Tile>
          <Tile title="Failed runs" at={box(6, 0, 3, 4)}>
            <BigNumber value={fmt(sum(failed))} />
          </Tile>
          <Tile title="Queued" at={box(9, 0, 3, 4)}>
            <BigNumber value="0" />
          </Tile>
          <Tile title="Run success %" mark="run-success" at={charts}>
            <Chart
              kind="line"
              width={chartWidth}
              height={chartBody - legendHeight(2)}
              yTicks={[0, 25, 50, 75, 100]}
              maxLabel={compact(Math.round(Math.max(...success[0].values)))}
              xLabels={hours.map((h, i) => (i % 3 === 1 ? h : ""))}
              series={success}
            />
            <Legend
              label="Average"
              total={sig3((avg(success[0].values) + avg(success[1].values)) / 2)}
              items={success.map((s) => ({ ...s, value: sig3(avg(s.values)) }))}
            />
          </Tile>
          <Tile title="Runs by status" mark="runs-by-status" at={box(6, 4, 6, 13)}>
            <Chart
              kind="bar"
              width={chartWidth}
              height={chartBody - legendHeight(6)}
              yTicks={[0, 350, 700, 1050, 1400]}
              maxLabel={compact(Math.max(...totals))}
              xLabels={hours.map((h, i) => (i % 3 === 0 ? h : ""))}
              series={statuses}
            />
            <Legend
              label="Sum"
              total={fmt(total)}
              items={legendRows.map((s) => ({ ...s, value: fmt(sum(s.values)) }))}
              more={statuses.length - legendRows.length}
            />
          </Tile>
          {/* The page continues below (the Failed runs section); the figure stops after the charts. */}
          <div style={{ height: charts.top + charts.height + 10 }} />
        </div>
      </div>
    </div>
  );
}
