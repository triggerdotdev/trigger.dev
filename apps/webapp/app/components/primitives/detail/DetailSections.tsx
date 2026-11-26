import {
  ArrowPathIcon,
  CheckIcon,
  ExclamationTriangleIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { motion } from "framer-motion";
import { type CSSProperties, type ReactNode } from "react";
import { cn } from "~/utils/cn";
import { formatNumber } from "~/utils/numberFormatter";
import { Button } from "../Buttons";
import { Header3 } from "../Headers";
import { Paragraph } from "../Paragraph";
import { Spinner } from "../Spinner";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "../Table";

/* Main-column pieces for the detail page template: section headings, the table tab, the progress
 * meter, version comparison, the Activity timeline, Settings rows and the three tab states.
 * Tables run edge to edge in the main column (DetailTableTab); everything else is padded
 * (DetailMain). */

/**
 * A tab whose content is a table: an optional toolbar row, then the table filling the rest edge
 * to edge, scrolling under its sticky header like the runs list.
 */
export function DetailTableTab({
  tools,
  actions,
  above,
  children,
}: {
  /** Left side of the toolbar: a view switch, filters, a search. */
  tools?: ReactNode;
  /** Right side of the toolbar: links out, bulk actions, pagination. */
  actions?: ReactNode;
  /** A fixed band between the toolbar and the table, e.g. a chart the toolbar's filters drive. */
  above?: ReactNode;
  /** A house Table with `showTopBorder={false}` and `stickyHeader`. */
  children: ReactNode;
}) {
  const hasToolbar = tools !== undefined || actions !== undefined;
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {hasToolbar ? (
        <div className="flex min-h-10 flex-none items-center justify-between gap-2 border-b border-grid-bright px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">{tools}</div>
          <div className="flex flex-none items-center gap-1.5">{actions}</div>
        </div>
      ) : null}
      {above}
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        {children}
      </div>
    </div>
  );
}

/** A section heading in the main column: title, optional count, and controls on the right. */
export function DetailSectionHeading({
  title,
  count,
  actions,
}: {
  title: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-2">
      <Header3 className="flex items-center gap-2">
        {title}
        {count !== undefined ? (
          <span className="text-xs font-medium tabular-nums text-text-faint">{count}</span>
        ) : null}
      </Header3>
      {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

/** A heading with the content under it, at the main column's tighter inner gap. */
export function DetailSection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={cn("flex flex-col gap-1.5", className)}>{children}</section>;
}

export type MeterSegment = {
  count: number;
  /** Shown after the count in the legend, e.g. "replayed successfully". */
  label: string;
  /** A background class, e.g. `bg-success`. */
  className: string;
  /** Leave a zero-count segment out of the legend. */
  hideWhenZero?: boolean;
};

/** Processed out of total, split into segments, with what's left shown as remaining. */
export function ProgressMeter({
  title = "Runs processed",
  total,
  segments,
}: {
  title?: ReactNode;
  total: number;
  segments: MeterSegment[];
}) {
  const processed = segments.reduce((sum, segment) => sum + segment.count, 0);
  const remaining = Math.max(0, total - processed);
  const percent = (count: number) => (total === 0 ? 0 : (count / total) * 100);
  const offsets = segments.map((_, index) =>
    segments.slice(0, index).reduce((sum, segment) => sum + percent(segment.count), 0)
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-text-bright">{title}</span>
        <span className="tabular-nums text-text-dimmed">
          {formatNumber(processed)} / {formatNumber(total)}
        </span>
      </div>
      <div
        className="relative h-3.5 w-full overflow-hidden rounded-sm bg-background-deep"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={processed}
      >
        {segments.map((segment, index) => {
          const style = { width: `${percent(segment.count)}%`, left: `${offsets[index]}%` };
          return (
            <motion.div
              key={segment.label}
              className={cn("absolute top-0 h-full", segment.className)}
              initial={style}
              animate={style}
              transition={{ duration: 0.3, ease: "easeOut" }}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-text-dimmed">
        {segments
          .filter((segment) => !(segment.hideWhenZero && segment.count === 0))
          .map((segment) => (
            <span key={segment.label} className="inline-flex items-center gap-1.5">
              <i className={cn("inline-block size-2 rounded-[1px]", segment.className)} />
              {formatNumber(segment.count)} {segment.label}
            </span>
          ))}
        {remaining > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block size-2 rounded-[1px] bg-background-deep outline outline-1 outline-border-bright" />
            {formatNumber(remaining)} remaining
          </span>
        ) : null}
      </div>
    </div>
  );
}

type ActivityStepStatus = "ok" | "fail" | "running" | "pending";

export type ActivityStep = {
  status: ActivityStepStatus;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned: the time, and a duration after a dot. */
  time?: ReactNode;
  /** Inline logs on the step that matters. */
  logs?: ReactNode;
};

/** What happened to the entity, newest last. A failure gets a callout at the top. */
export function ActivityTimeline({
  steps,
  failure,
  className,
}: {
  steps: ActivityStep[];
  failure?: { title: ReactNode; description?: ReactNode; action?: ReactNode };
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {failure ? <FailureCallout {...failure} /> : null}
      <ol className="flex flex-col">
        {steps.map((step, index) => (
          <li
            key={index}
            className="relative grid grid-cols-[1.375rem_minmax(0,1fr)_auto] gap-3 pb-4 last:pb-0"
          >
            {index < steps.length - 1 ? (
              <span className="absolute bottom-0 left-[0.656rem] top-[1.375rem] w-px bg-grid-bright" />
            ) : null}
            <StepMark status={step.status} />
            <div className="min-w-0">
              <div
                className={cn(
                  "pt-px text-sm",
                  step.status === "fail"
                    ? "text-error"
                    : step.status === "pending"
                      ? "text-text-faint"
                      : "text-text-bright"
                )}
              >
                {step.title}
              </div>
              {step.description ? (
                <div className="text-xs text-text-dimmed">{step.description}</div>
              ) : null}
              {step.logs ? (
                <pre className="mt-2 overflow-x-auto rounded bg-background-deep px-2.5 py-2 font-mono text-[0.71875rem] leading-relaxed text-text-dimmed scrollbar-thin">
                  {step.logs}
                </pre>
              ) : null}
            </div>
            <span className="whitespace-nowrap pt-0.5 text-xs tabular-nums text-text-faint">
              {step.time}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepMark({ status }: { status: ActivityStepStatus }) {
  const base = "relative z-1 grid size-[1.3125rem] place-items-center rounded-full border";
  switch (status) {
    case "ok":
      return (
        <span className={cn(base, "border-success/50 bg-background-bright text-success")}>
          <CheckIcon className="size-3.5" />
        </span>
      );
    case "fail":
      return (
        <span className={cn(base, "border-error/60 bg-error/10 text-error")}>
          <XMarkIcon className="size-3.5" />
        </span>
      );
    case "running":
      return (
        <span className={cn(base, "border-pending/60 bg-background-bright")}>
          <Spinner className="size-3 text-pending" />
        </span>
      );
    case "pending":
      return (
        <span className={cn(base, "border-border-bright bg-background-bright text-text-faint")}>
          <span className="h-px w-2 bg-current" />
        </span>
      );
  }
}

function FailureCallout({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded bg-error/8 px-3 py-2.5" role="alert">
      <ExclamationTriangleIcon className="mt-0.5 size-4 flex-none text-error" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-error">{title}</div>
        {description ? <div className="text-xs text-text-bright/80">{description}</div> : null}
      </div>
      {action ? <div className="flex flex-none items-center gap-1.5">{action}</div> : null}
    </div>
  );
}

/** A group of Settings rows under a small heading. */
export function SettingGroup({
  title,
  danger = false,
  children,
}: {
  title: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="flex max-w-[47.5rem] flex-col gap-1.5">
      <h3
        className={cn(
          "-mb-1 text-[0.6875rem] font-medium uppercase tracking-[0.07em]",
          danger ? "text-error" : "text-text-faint"
        )}
      >
        {title}
      </h3>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/** Label and description, then the current value right-aligned just before its control. */
export function SettingRow({
  title,
  description,
  value,
  control,
}: {
  title: ReactNode;
  description?: ReactNode;
  value?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-grid-dimmed py-2.5 text-sm">
      <div className="flex w-[15.625rem] flex-none flex-col gap-px">
        <span className="font-medium text-text-bright">{title}</span>
        {description ? <span className="text-xs text-text-faint">{description}</span> : null}
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-6 text-text-dimmed">
        {value !== undefined ? (
          <div className="flex min-w-0 items-center justify-end truncate">{value}</div>
        ) : null}
        {control ? <div className="flex flex-none items-center">{control}</div> : null}
      </div>
    </div>
  );
}

/** Destructive actions, last on the Settings tab. Time-sensitive stops stay in the header. */
export function DangerZone({ children }: { children: ReactNode }) {
  return (
    <SettingGroup title="Danger zone" danger>
      {children}
    </SettingGroup>
  );
}

/**
 * A grey placeholder for a value that's on its way. The light sweep is pinned to the viewport
 * (`bg-fixed`), so every bone on the page shimmers as one band instead of each on its own beat.
 * With reduced motion it's flat grey.
 */
export function SkeletonBone({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      aria-hidden
      className={cn(
        "block h-3 rounded-sm bg-background-raised",
        "motion-safe:animate-text-shimmer motion-safe:bg-fixed motion-safe:bg-[length:250%_100%]",
        "motion-safe:bg-[linear-gradient(90deg,var(--color-background-raised)_35%,var(--color-surface-control)_50%,var(--color-background-raised)_65%)]",
        className
      )}
      style={style}
    />
  );
}

/** Varied but stable widths, so rows read as text of different lengths, not a grid of bars. */
function boneWidth(row: number, column: number) {
  return `${45 + ((row * 37 + column * 23) % 45)}%`;
}

export type SkeletonColumn = { label: string; alignment?: "left" | "right" };

/**
 * The table the tab will show, with its real header and placeholder rows, edge to edge. Pass the
 * table's column labels; a number gives that many unlabelled columns.
 */
export function DetailTabLoading({
  columns = 4,
  rows = 8,
}: {
  columns?: number | SkeletonColumn[];
  rows?: number;
}) {
  const specs: SkeletonColumn[] =
    typeof columns === "number" ? Array.from({ length: columns }, () => ({ label: "" })) : columns;
  return (
    <div aria-busy="true" aria-label="Loading">
      <Table variant="dimmed" showTopBorder={false} stickyHeader>
        <TableHeader>
          <TableRow>
            {specs.map((column, index) => (
              <TableHeaderCell key={index} alignment={column.alignment}>
                {column.label || <SkeletonBone className="h-2.5 w-12" />}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, row) => (
            <TableRow key={row}>
              {specs.map((column, index) => (
                <TableCell key={index} alignment={column.alignment}>
                  <div
                    className={cn(
                      "flex h-5 items-center",
                      column.alignment === "right" && "justify-end"
                    )}
                  >
                    <SkeletonBone
                      style={{
                        width: index === 0 ? "5.5rem" : boneWidth(row, index),
                        maxWidth: "9rem",
                      }}
                    />
                  </div>
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Bar heights for the chart placeholder: a gentle wave with some noise, fixed per index. */
const CHART_SKELETON_HEIGHTS = Array.from({ length: 36 }, (_, i) =>
  Math.round(22 + 30 * Math.abs(Math.sin(i / 4.5)) + ((i * 53) % 17))
);

/** A bar chart's frame: gridlines, axes and shimmering bars where the data will be. */
export function ChartSkeleton({ bars = 36 }: { bars?: number }) {
  return (
    <div className="flex h-full gap-2" aria-busy="true" aria-label="Loading chart">
      <div className="flex flex-none flex-col justify-between pb-5">
        {[0, 1, 2, 3].map((tick) => (
          <SkeletonBone key={tick} className="h-2 w-5" />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 items-end gap-[3px] border-b border-grid-bright">
          {[25, 50, 75].map((top) => (
            <span
              key={top}
              aria-hidden
              className="absolute inset-x-0 border-t border-dashed border-grid-dimmed"
              style={{ top: `${top}%` }}
            />
          ))}
          {Array.from({ length: bars }).map((_, i) => (
            <SkeletonBone
              key={i}
              className="h-auto flex-1 rounded-b-none"
              style={{
                height: `${CHART_SKELETON_HEIGHTS[i % CHART_SKELETON_HEIGHTS.length]}%`,
              }}
            />
          ))}
        </div>
        <div className="flex h-5 items-end justify-between">
          {[0, 1, 2, 3, 4].map((tick) => (
            <SkeletonBone key={tick} className="h-2 w-9" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** A one-line reason and the action that fills the tab. */
export function DetailTabEmpty({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[13rem] flex-col items-center justify-center gap-2.5 p-4 text-center">
      <Header3>{title}</Header3>
      {description ? (
        <Paragraph variant="small" className="max-w-[30ch]">
          {description}
        </Paragraph>
      ) : null}
      {action}
    </div>
  );
}

/** The title in the error colour, the cause, and a Retry button. */
export function DetailTabError({
  title,
  cause,
  onRetry,
}: {
  title: ReactNode;
  cause?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div
      className="flex min-h-[13rem] flex-col items-center justify-center gap-2.5 p-4 text-center"
      role="alert"
    >
      <Header3 className="text-error">{title}</Header3>
      {cause ? (
        <Paragraph variant="small" className="max-w-[30ch]">
          {cause}
        </Paragraph>
      ) : null}
      {onRetry ? (
        <Button variant="secondary/small" LeadingIcon={ArrowPathIcon} onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
