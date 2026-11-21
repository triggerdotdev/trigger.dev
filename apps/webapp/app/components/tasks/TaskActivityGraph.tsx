import type { TaskRunStatus } from "@trigger.dev/database";
import { ActivityBarChartBlankState } from "~/components/metrics/ActivityBarChartBlankState";
import { LazyLoad, lazyWithRetry } from "~/components/primitives/LazyLoad";

/** One hour bucket: its start, the total for axis scaling, and per-status counts. */
export type TaskActivityBucket = { date: Date; total: number } & Partial<
  Record<TaskRunStatus, number>
>;

// chart (112) + gap-1.5 (6) + count min-w (28). Reserved so the column stays put while the chart unmounts.
export const ACTIVITY_CELL_WIDTH = 146;

// recharts is ~80 KB compressed. The sparklines fill in from deferred data after the page is
// interactive anyway, so their code loads alongside that data instead of before hydration.
const TaskActivityGraphChart = lazyWithRetry(() =>
  import("./TaskActivityGraphChart").then((module) => ({ default: module.TaskActivityGraphChart }))
);

/** The tasks list's 24-hour runs sparkline, stacked by status. */
export function TaskActivityGraph({ activity }: { activity: TaskActivityBucket[] }) {
  return (
    // A sparkline that can't load stays blank: a table cell has no room for a message.
    <LazyLoad
      fallback={<ActivityBarChartBlankState />}
      errorFallback={<ActivityBarChartBlankState />}
    >
      <TaskActivityGraphChart activity={activity} />
    </LazyLoad>
  );
}
