import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Link } from "@remix-run/react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { DeploymentStatusIcon } from "~/components/runs/v3/DeploymentStatus";
import { useLocales } from "~/components/primitives/LocaleProvider";
import { cn } from "~/utils/cn";
import { formatNumber } from "~/utils/numberFormatter";
import { type ActivityDay, GRID_WEEKS, addDays, gridWeeks, parseDay } from "./deployActivityDays";

/* The deployment activity grid: one square per day, a week per column, filled by how many deploys
 * went live that day, with a red corner on days where a deploy failed. The band that puts it above
 * the deployments list is in DeployActivityViews.tsx; this file is the grid itself, its legend and
 * its hover card. */

export type DayDeployment = {
  shortCode: string;
  version: string;
  status:
    | "PENDING"
    | "INSTALLING"
    | "BUILDING"
    | "DEPLOYING"
    | "DEPLOYED"
    | "FAILED"
    | "CANCELED"
    | "TIMED_OUT";
  /** ISO time. */
  createdAt: string;
  deployedBy: string | null;
  commitMessage: string | null;
};

export type LoadDay = (day: string) => Promise<DayDeployment[]>;

/**
 * Fixed steps, not quartiles of the environment's own history, so the same green means the same
 * number of deploys in every environment and every grid can share one legend.
 */
const LEVEL_FLOORS = [1, 2, 4, 7];

function level(deployed: number): number {
  let result = 0;
  for (const floor of LEVEL_FLOORS) if (deployed >= floor) result += 1;
  return result;
}

/** One hue, light to strong, mixed from the theme's tokens so it follows light and dark. */
const LEVEL_BACKGROUND = [
  "var(--color-background-raised)",
  "color-mix(in oklab, var(--color-success) 30%, var(--color-background-raised))",
  "color-mix(in oklab, var(--color-success) 52%, var(--color-background-raised))",
  "color-mix(in oklab, var(--color-success) 76%, var(--color-background-raised))",
  "var(--color-success)",
];

const LEVEL_LABEL = ["No deploys", "1 deploy", "2 to 3 deploys", "4 to 6 deploys", "7 or more"];

function Square({
  size,
  filled,
  failed,
  className,
}: {
  size: number;
  /** 0 to 4. */
  filled: number;
  failed?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("relative block overflow-hidden rounded-[2px]", className)}
      style={{ width: size, height: size, background: LEVEL_BACKGROUND[filled] }}
    >
      {failed ? (
        <>
          {/* A cut in the surface colour keeps the red corner apart from the green. */}
          <span className="absolute bottom-0 right-0 size-[82%] bg-background-bright [clip-path:polygon(100%_0,100%_100%,0_100%)]" />
          <span className="absolute bottom-0 right-0 size-[64%] bg-error [clip-path:polygon(100%_0,100%_100%,0_100%)]" />
        </>
      ) : null}
    </span>
  );
}

/** "Less [][][][][] More" and the failed corner, as small as GitHub's. */
export function DeployGridLegend({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3 text-xxs text-text-dimmed", className)}>
      <span className="flex items-center gap-[3px]">
        <span className="mr-0.5">Less</span>
        {LEVEL_BACKGROUND.map((_, index) => (
          <span key={index} title={LEVEL_LABEL[index]}>
            <Square size={10} filled={index} />
          </span>
        ))}
        <span className="ml-0.5">More</span>
      </span>
      <span className="flex items-center gap-1">
        <Square size={10} filled={0} failed />
        Failed
      </span>
    </div>
  );
}

const ARROW_STEPS: Record<string, number> = {
  ArrowUp: -1,
  ArrowDown: 1,
  ArrowLeft: -7,
  ArrowRight: 7,
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthOf(day: string): number {
  return Number(day.slice(5, 7)) - 1;
}

type GridProps = {
  /** YYYY-MM-DD: the last day drawn. */
  today: string;
  days: ActivityDay[];
  /** Square size and the gap between squares, in px. */
  cell?: number;
  gap?: number;
  weeks?: number;
  /** Where a click on a day goes. Days without a link aren't clickable. */
  dayHref?: (day: ActivityDay | { day: string; total: 0 }) => string | undefined;
  /** The day the list is filtered to. */
  selectedDay?: string;
  /** A lighter outline that comes and goes, e.g. the longest gap while its figure is hovered. */
  highlighted?: { from: string; to: string };
  /** The hover card's deploys for a day. Without it the card shows only the counts. */
  loadDay?: LoadDay;
  /** Names the grid for screen readers. */
  label: string;
};

/** The grid of squares, a week per column with the oldest on the left, with keyboard movement
 * and one shared hover card. */
export function DeployGrid({
  today,
  days,
  cell = 11,
  gap = 3,
  weeks = GRID_WEEKS,
  dayHref,
  selectedDay,
  highlighted,
  loadDay,
  label,
}: GridProps) {
  const byDay = useMemo(() => new Map(days.map((entry) => [entry.day, entry])), [days]);
  const columns = useMemo(() => gridWeeks(today, weeks), [today, weeks]);
  const containerRef = useRef<HTMLDivElement>(null);
  // Days this grid has already read, so moving back over a square is instant.
  const [loadedDays, setLoadedDays] = useState<Record<string, DayDeployment[]>>({});
  const [hover, setHover] = useState<{
    day: string;
    left: number;
    top: number;
  } | null>(null);

  const focusable = selectedDay ?? today;

  // The hover card's deploys are read here, not in the card: Radix renders a tooltip's content
  // twice (once hidden, for screen readers), which would ask for each day twice.
  const hoverDay = hover?.day;
  const hoverTotal = hoverDay ? (byDay.get(hoverDay)?.total ?? 0) : 0;
  const hoverLoaded = hoverDay ? loadedDays[hoverDay] !== undefined : false;
  useEffect(() => {
    if (!loadDay || !hoverDay || hoverTotal === 0 || hoverLoaded) return;
    // Passing over squares on the way somewhere else shouldn't ask for each of them.
    const timer = setTimeout(() => {
      loadDay(hoverDay)
        .catch((): DayDeployment[] => [])
        .then((result) => setLoadedDays((known) => ({ ...known, [hoverDay]: result })));
    }, 120);
    return () => clearTimeout(timer);
  }, [loadDay, hoverDay, hoverTotal, hoverLoaded]);

  const show = (day: string, element: HTMLElement) => {
    const container = containerRef.current;
    if (!container) return;
    const box = element.getBoundingClientRect();
    const origin = container.getBoundingClientRect();
    setHover({ day, left: box.left - origin.left, top: box.top - origin.top });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = (event.target as HTMLElement).dataset?.day;
    if (!current) return;
    // Arrow keys follow the layout: up and down a week, left and right between weeks.
    const step = ARROW_STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = containerRef.current?.querySelector<HTMLElement>(
      `[data-day="${addDays(current, step)}"]`
    );
    next?.focus();
  };

  const within = (day: string, range?: { from: string; to: string }) =>
    !!range && day >= range.from && day <= range.to;

  return (
    <TooltipPrimitive.Provider delayDuration={0} disableHoverableContent>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- The squares are the focusable elements; the group only moves focus between them on arrow keys and closes the hover card when the pointer leaves. */}
      <div
        ref={containerRef}
        role="group"
        aria-label={label}
        className="relative w-fit"
        onKeyDown={onKeyDown}
        onMouseLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
      >
        <div
          className="grid text-xxs leading-none text-text-faint"
          style={{
            gap,
            gridTemplateColumns: `auto repeat(${columns.length}, ${cell}px)`,
            gridTemplateRows: `auto repeat(7, ${cell}px)`,
          }}
        >
          {/* Down the side: weekday names. */}
          {["Mon", "", "Wed", "", "Fri", "", ""].map((name, index) =>
            name ? (
              <span
                key={`weekday-${index}`}
                className="flex items-center pr-1.5"
                style={{ gridColumn: 1, gridRow: index + 2 }}
              >
                {name}
              </span>
            ) : null
          )}
          {/* Along the top: a month name where the month changes. */}
          {columns.map((days, index) => {
            const anchor = firstDay(days);
            const before = columns[index - 1];
            const previous = before ? firstDay(before) : undefined;
            if (!anchor || (previous && monthOf(previous) === monthOf(anchor))) return null;
            // A first column that's the tail of a month would run into the next label.
            const after = columns[index + 1];
            const next = after ? firstDay(after) : undefined;
            if (index === 0 && next && monthOf(next) !== monthOf(anchor)) return null;
            return (
              <span
                key={`month-${anchor}`}
                className="w-0 overflow-visible whitespace-nowrap pb-1"
                style={{ gridRow: 1, gridColumn: index + 2 }}
              >
                {MONTHS[monthOf(anchor)]}
              </span>
            );
          })}
          {columns.map((days, weekIndex) =>
            days.map((day, weekday) => {
              if (!day) return null;
              const entry = byDay.get(day);
              const href = dayHref?.(entry ?? { day, total: 0 });
              const isSelected = day === selectedDay;
              const className = cn(
                "block rounded-[2px] outline-offset-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-text-link",
                "hover:outline hover:outline-1 hover:outline-text-dimmed",
                href && "cursor-pointer hover:outline-text-bright",
                within(day, highlighted) && "outline outline-1 outline-warning",
                isSelected && "outline outline-2 outline-text-bright"
              );
              const style = { gridColumn: weekIndex + 2, gridRow: weekday + 2 };
              const common = {
                "data-day": day,
                "aria-label": describeDay(day, entry),
                "aria-current": isSelected ? ("date" as const) : undefined,
                tabIndex: day === focusable ? 0 : -1,
                className,
                style,
                onMouseEnter: (event: { currentTarget: HTMLElement }) =>
                  show(day, event.currentTarget),
                onFocus: (event: { currentTarget: HTMLElement }) => show(day, event.currentTarget),
              };
              const square = (
                <Square
                  size={cell}
                  filled={level(entry?.deployed ?? 0)}
                  failed={(entry?.failed ?? 0) > 0}
                />
              );
              return href ? (
                <Link key={day} to={href} preventScrollReset {...common}>
                  {square}
                </Link>
              ) : (
                <span key={day} role="img" {...common}>
                  {square}
                </span>
              );
            })
          )}
        </div>
        {hover ? (
          <TooltipPrimitive.Root key={hover.day} open>
            <TooltipPrimitive.Trigger asChild>
              <span
                aria-hidden
                className="pointer-events-none absolute"
                style={{ left: hover.left, top: hover.top, width: cell, height: cell }}
              />
            </TooltipPrimitive.Trigger>
            <TooltipPrimitive.Portal>
              <TooltipPrimitive.Content
                side="top"
                sideOffset={6}
                collisionPadding={8}
                className="pointer-events-none z-50 w-64 rounded border border-grid-bright bg-background-bright px-3 py-2.5 text-xs shadow-md"
              >
                <DayCard
                  day={hover.day}
                  entry={byDay.get(hover.day)}
                  deployments={loadDay ? loadedDays[hover.day] : undefined}
                  hasList={!!loadDay}
                />
              </TooltipPrimitive.Content>
            </TooltipPrimitive.Portal>
          </TooltipPrimitive.Root>
        ) : null}
      </div>
    </TooltipPrimitive.Provider>
  );
}

function firstDay(days: (string | null)[]) {
  return days.find((day): day is string => day !== null);
}

function plural(count: number, noun: string) {
  return `${formatNumber(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function describeDay(day: string, entry: ActivityDay | undefined) {
  const date = parseDay(day).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  if (!entry || entry.total === 0) return `${date}: no deploys`;
  return `${date}: ${plural(entry.total, "deploy")}${
    entry.failed > 0 ? `, ${formatNumber(entry.failed)} failed` : ""
  }`;
}

function DayCard({
  day,
  entry,
  deployments,
  hasList,
}: {
  day: string;
  entry: ActivityDay | undefined;
  /** The day's deploys, newest first; undefined while they load. */
  deployments: DayDeployment[] | undefined;
  /** Whether the grid lists a day's deploys at all. */
  hasList: boolean;
}) {
  const locales = useLocales();
  const total = entry?.total ?? 0;

  const date = parseDay(day).toLocaleDateString(locales, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const other = total - (entry?.deployed ?? 0) - (entry?.failed ?? 0);
  const listed = Math.min(total, 6);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium text-text-bright">{date}</span>
          <span className="whitespace-nowrap tabular-nums text-text-dimmed">
            {total === 0 ? "No deploys" : plural(total, "deploy")}
          </span>
        </div>
        {total > 0 && (entry?.failed || other > 0) ? (
          <div className="flex items-center gap-2.5 text-text-dimmed">
            {entry?.failed ? (
              <span className="flex items-center gap-1 text-error">
                <DeploymentStatusIcon status="FAILED" className="size-3.5" />
                {formatNumber(entry.failed)} failed
              </span>
            ) : null}
            {other > 0 ? <span>{formatNumber(other)} canceled or in progress</span> : null}
          </div>
        ) : null}
      </div>
      {hasList && total > 0 ? (
        <ul className="flex flex-col gap-1 border-t border-grid-dimmed pt-1.5">
          {deployments
            ? deployments.map((deployment) => (
                <li key={deployment.shortCode} className="flex items-center gap-1.5">
                  <DeploymentStatusIcon status={deployment.status} className="size-3.5 flex-none" />
                  <span className="flex-none tabular-nums text-text-bright">
                    {deployment.version}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text-dimmed">
                    {deployment.deployedBy ?? ""}
                  </span>
                  <span className="flex-none tabular-nums text-text-faint">
                    {new Date(deployment.createdAt).toLocaleTimeString(locales, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </li>
              ))
            : Array.from({ length: listed }).map((_, index) => (
                <li key={index} className="flex h-4 items-center gap-1.5">
                  <span className="size-3.5 flex-none rounded-full bg-background-raised" />
                  <span className="h-2.5 w-20 rounded-sm bg-background-raised" />
                  <span className="h-2.5 flex-1 rounded-sm bg-background-raised" />
                </li>
              ))}
          {deployments && total > deployments.length ? (
            <li className="text-text-faint">and {formatNumber(total - deployments.length)} more</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
