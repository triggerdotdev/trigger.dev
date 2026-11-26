// Parts shared by the task and schedule figures: the task-kind icons (TaskTriggerSource.tsx), the
// tasks list's activity sparkline (metrics/ActivityBarChart.tsx) and the page title's question-mark
// accessory (PageHeader.tsx).
import * as I from "./icons";

type P = { className?: string };

// app/assets/icons/ClockIcon.tsx: the scheduled-task clock (not heroicons' ClockIcon).
export function ScheduleClockIcon({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <line
        x1="12"
        y1="7"
        x2="12"
        y2="12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M15.5 15.5L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// app/assets/icons/CubeSparkleIcon.tsx
function CubeSparkleIcon({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 7C12.4304 7 12.8126 7.27543 12.9487 7.68378L13.4743 9.26076C13.6734 9.85797 14.142 10.3266 14.7393 10.5257L16.3162 11.0513C16.7246 11.1875 17 11.5696 17 12C17 12.4305 16.7246 12.8126 16.3162 12.9487L14.7393 13.4744C14.142 13.6734 13.6734 14.1421 13.4743 14.7393L12.9487 16.3163C12.8126 16.7246 12.4304 17 12 17C11.5696 17 11.1874 16.7246 11.0513 16.3163L10.5256 14.7393C10.3266 14.1421 9.85794 13.6734 9.26073 13.4744L7.68374 12.9487C7.2754 12.8126 6.99997 12.4305 6.99997 12C6.99997 11.5696 7.2754 11.1875 7.68374 11.0513L9.26073 10.5257C9.85794 10.3266 10.3266 9.85797 10.5256 9.26076L11.0513 7.68378C11.1874 7.27543 11.5696 7 12 7Z"
        fill="currentColor"
      />
      <path
        d="M11 2.18502C11.6188 1.82775 12.3812 1.82775 13 2.18502L20 6.22647C20.6188 6.58373 21 7.24399 21 7.95852V16.0414C21 16.756 20.6188 17.4162 20 17.7735L13 21.8149C12.3812 22.1722 11.6188 22.1722 11 21.8149L4 17.7735C3.3812 17.4162 3 16.756 3 16.0414V7.95852C3 7.24399 3.3812 6.58373 4 6.22647L11 2.18502Z"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

export type TaskKind = "STANDARD" | "SCHEDULED" | "AGENT" | "WEBHOOK";

/** runs/v3/TaskTriggerSource.tsx */
export function TaskKindIcon({ kind, className = "" }: { kind: TaskKind; className?: string }) {
  switch (kind) {
    case "STANDARD":
      return <I.TaskSmallIcon className={`size-4.5 min-w-4.5 text-tasks ${className}`} />;
    case "SCHEDULED":
      return <ScheduleClockIcon className={`size-4.5 min-w-4.5 text-schedules ${className}`} />;
    case "AGENT":
      return <CubeSparkleIcon className={`size-4.5 min-w-4.5 text-agents ${className}`} />;
    case "WEBHOOK":
      return (
        <I.WebhooksIcon className={`size-[1.125rem] min-w-[1.125rem] text-webhooks ${className}`} />
      );
  }
}

// ActivityBarChart: 112x24, 24 hourly buckets, recharts' default 10% gap either side of a bar.
const CHART_W = 112;
const CHART_H = 24;
const PEAK = "-mt-1 inline-block min-w-7 text-xxs tabular-nums text-text-dimmed";

/** A 24-hour activity sparkline: `ok` and `failed` runs per hour, stacked. Empty: the blank state. */
export function ActivitySparkline({ ok, failed = [] }: { ok?: number[]; failed?: number[] }) {
  if (!ok) {
    return (
      <div className="flex items-start gap-1.5">
        <svg width={CHART_W} height={CHART_H} className="rounded-sm">
          <line
            x1={0}
            y1={CHART_H}
            x2={CHART_W}
            y2={CHART_H}
            stroke="var(--color-border-bright)"
            strokeWidth={1}
          />
        </svg>
        <span className={PEAK}>0</span>
      </div>
    );
  }
  const totals = ok.map((n, i) => n + (failed[i] ?? 0));
  const max = Math.max(...totals);
  const band = CHART_W / ok.length;
  const bar = band * 0.8;
  return (
    <div className="flex items-start gap-1.5">
      <div className="rounded-sm" style={{ width: CHART_W, height: CHART_H }}>
        <svg width={CHART_W} height={CHART_H}>
          {ok.map((n, i) => {
            const x = i * band + band * 0.1;
            const okH = (n / max) * CHART_H;
            const failH = ((failed[i] ?? 0) / max) * CHART_H;
            return (
              <g key={i}>
                {okH > 0 && (
                  <rect
                    x={x}
                    y={CHART_H - okH}
                    width={bar}
                    height={okH}
                    fill="var(--color-run-completed-successfully)"
                  />
                )}
                {failH > 0 && (
                  <rect
                    x={x}
                    y={CHART_H - okH - failH}
                    width={bar}
                    height={failH}
                    fill="var(--color-run-completed-with-errors)"
                  />
                )}
              </g>
            );
          })}
          <line
            x1={0}
            y1={CHART_H}
            x2={CHART_W}
            y2={CHART_H}
            stroke="var(--color-border-bright)"
            strokeWidth={1}
          />
          <line
            x1={0}
            y1={0}
            x2={CHART_W}
            y2={0}
            stroke="var(--color-border-brighter)"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
        </svg>
      </div>
      <span className={PEAK}>{max}</span>
    </div>
  );
}
