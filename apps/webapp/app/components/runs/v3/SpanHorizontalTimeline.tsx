import { DateTimeAccurate } from "~/components/primitives/DateTime";

function formatSpanDuration(nanoseconds: number): string {
  const ms = nanoseconds / 1_000_000;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSecs = Math.round(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}m ${secs}s`;
}

export function SpanHorizontalTimeline({
  startTime,
  duration,
}: {
  startTime: string | Date;
  duration: number | null;
}) {
  const startDate = startTime instanceof Date ? startTime : new Date(startTime);
  const endDate = duration != null ? new Date(startDate.getTime() + duration / 1_000_000) : null;

  return (
    <div className="@container/timeline">
      <div className="flex flex-col gap-0.5 px-1 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-text-bright">Started</span>
          <span className="text-xs font-medium text-text-bright">Finished</span>
        </div>
        <div className="flex items-center">
          <span className="shrink-0 tabular-nums text-xxs text-text-dimmed @[350px]/timeline:text-xs">
            <DateTimeAccurate date={startDate} showTooltip={false} />
          </span>
          <div className="ml-2 h-3 w-px bg-charcoal-600" />
          <div className="h-px flex-1 bg-charcoal-600" />
          {duration != null && (
            <span className="shrink-0 tabular-nums px-2 text-xxs text-text-dimmed @[350px]/timeline:text-xs">
              {formatSpanDuration(duration)}
            </span>
          )}
          <div className="h-px flex-1 bg-charcoal-600" />
          <div className="mr-2 h-3 w-px bg-charcoal-600" />
          <span className="shrink-0 tabular-nums text-xxs text-text-dimmed @[350px]/timeline:text-xs">
            {endDate ? (
              <DateTimeAccurate date={endDate} previousDate={startDate} showTooltip={false} />
            ) : (
              <span className="text-charcoal-500">—</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
