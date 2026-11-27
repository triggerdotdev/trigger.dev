import { Fragment } from "react";
import { Bar, type TooltipProps } from "recharts";
import type { TaskRunStatus } from "@trigger.dev/database";
import type { TaskActivityBucket } from "./TaskActivityGraph";
import { ActivityBarChart } from "~/components/metrics/ActivityBarChart";
import { formatDateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import TooltipPortal from "~/components/primitives/TooltipPortal";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import { formatNumberCompact } from "~/utils/numberFormatter";

const STATUS_BARS: { status: TaskRunStatus; fill: string }[] = [
  { status: "DELAYED", fill: "var(--color-run-delayed)" },
  { status: "PENDING", fill: "var(--color-run-pending)" },
  { status: "PENDING_VERSION", fill: "var(--color-run-pending-version)" },
  { status: "EXECUTING", fill: "var(--color-run-executing)" },
  { status: "RETRYING_AFTER_FAILURE", fill: "var(--color-run-retrying-after-failure)" },
  { status: "WAITING_TO_RESUME", fill: "var(--color-run-waiting-to-resume)" },
  { status: "COMPLETED_SUCCESSFULLY", fill: "var(--color-run-completed-successfully)" },
  { status: "CANCELED", fill: "var(--color-run-canceled)" },
  { status: "COMPLETED_WITH_ERRORS", fill: "var(--color-run-completed-with-errors)" },
  { status: "INTERRUPTED", fill: "var(--color-run-interrupted)" },
  { status: "SYSTEM_FAILURE", fill: "var(--color-run-system-failure)" },
  { status: "PAUSED", fill: "var(--color-run-paused)" },
  { status: "CRASHED", fill: "var(--color-run-crashed)" },
  { status: "EXPIRED", fill: "var(--color-run-expired)" },
  { status: "TIMED_OUT", fill: "var(--color-run-timed-out)" },
];

/** The tasks list's 24-hour runs sparkline, stacked by status. */
export function TaskActivityGraphChart({ activity }: { activity: TaskActivityBucket[] }) {
  const maxTotal = Math.max(...activity.map((d) => d.total));

  return (
    <ActivityBarChart
      data={activity}
      max={maxTotal}
      tooltip={<TaskActivityTooltip />}
      peak={formatNumberCompact(maxTotal)}
      peakTooltip="Peak runs in a single hour"
    >
      {STATUS_BARS.map(({ status, fill }) => (
        <Bar
          key={status}
          dataKey={status}
          stackId="a"
          fill={fill}
          strokeWidth={0}
          isAnimationActive={false}
        />
      ))}
    </ActivityBarChart>
  );
}

const TaskActivityTooltip = ({ active, payload }: TooltipProps<number, string>) => {
  if (active && payload && payload.length > 0) {
    const entry = payload[0].payload as { date: Date; total: number } & Partial<
      Record<TaskRunStatus, number>
    >;
    const date = entry.date instanceof Date ? entry.date : new Date(entry.date);
    const formattedDate = formatDateTime(date, "UTC", [], false, true);
    const items = STATUS_BARS.filter(({ status }) => (entry[status] ?? 0) > 0).map(
      ({ status }) => ({ status, value: entry[status] ?? 0 })
    );

    return (
      <TooltipPortal active={active}>
        <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
          <Header3 className="border-b border-b-border-bright pb-2">{formattedDate}</Header3>
          {items.length === 0 ? (
            <div className="mt-2 text-xs text-text-dimmed">No runs</div>
          ) : (
            <div className="mt-2 grid grid-cols-[1fr_auto] gap-2 text-xs text-text-bright">
              {items.map((item) => (
                <Fragment key={item.status}>
                  <TaskRunStatusCombo status={item.status} />
                  <p className="tabular-nums">{item.value}</p>
                </Fragment>
              ))}
            </div>
          )}
        </div>
      </TooltipPortal>
    );
  }
  return null;
};
