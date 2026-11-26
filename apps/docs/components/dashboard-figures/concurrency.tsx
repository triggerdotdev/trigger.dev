// The Concurrency page (the classic view; the metrics view is behind a flag) with one queue's row
// menu open. The tiles, toolbar and table header are copied from the rendered dashboard; the queue
// rows and the row menu are drawn from source (the reference dashboard has no queues). The
// webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import {
  AdjustmentsHorizontalIcon,
  ArchiveBoxArrowDownIcon,
  ArrowUpCircleIcon,
  PauseIcon as PauseSolidIcon,
  PlayIcon,
} from "@heroicons/react/20/solid";
import type { ReactNode } from "react";
import {
  AppFrame,
  Button,
  PageHeader,
  RowMenuItem,
  RowMenuPopover,
  SearchField,
  SideMenu,
  SmallSwitch,
  tableRow,
  td,
  th,
} from "./chrome";
import * as I from "./icons";

type P = { className?: string };

/** primitives/Spinner.tsx, default blue, still (the menu item passes animate-none). */
function SpinnerIcon({ className }: P) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="2"
        y="2"
        width="16"
        height="16"
        rx="8"
        stroke="rgba(59, 130, 246, 0.4)"
        strokeWidth="3"
      />
      <path
        d="M10 18C5.58172 18 2 14.4183 2 10C2 5.58172 5.58172 2 10 2"
        stroke="rgba(59, 130, 246)"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---- The tiles (BigNumber) ----

function Tile({
  title,
  accessory,
  children,
}: {
  title: string;
  accessory: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="group flex flex-col justify-between gap-4 rounded-lg border border-grid-bright bg-background-bright pb-4 pl-4 pr-3 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-sans text-sm font-semibold text-text-bright leading-6">{title}</div>
        <div className="shrink-0">{accessory}</div>
      </div>
      <div className="text-[3.75rem] font-normal leading-none text-text-bright tabular-nums">
        <div className="flex flex-wrap items-baseline gap-2">{children}</div>
      </div>
    </div>
  );
}

/** The icon-only "View queued runs" / "View running runs" link (secondary/small, px-2). */
function RunsLink() {
  return (
    <span className="block w-fit">
      <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 text-xs bg-secondary border border-border-bright/50 shadow-xs px-2">
        <div className="relative flex w-full items-center">
          <div className="justify-center flex w-full items-center text-text-bright gap-x-2.5">
            <I.RunsIcon className="h-3.5 -mx-1 text-runs shrink-0 justify-start" />
          </div>
        </div>
      </div>
    </span>
  );
}

// ---- The table ----

type Queue = {
  name: string;
  type: "task" | "custom";
  queued: number;
  running: number;
  /** The queue's own limit from code; null means it uses the environment's. */
  limit: number | null;
  paused?: boolean;
};

const ENV_LIMIT = 25;

const queues: Queue[] = [
  { name: "email-queue", type: "custom", queued: 3, running: 2, limit: 10 },
  { name: "hello-world", type: "task", queued: 0, running: 1, limit: null },
  { name: "nightly-report", type: "task", queued: 4, running: 0, limit: null, paused: true },
  { name: "process-image", type: "task", queued: 12, running: 5, limit: 5 },
  { name: "sync-contacts", type: "task", queued: 0, running: 0, limit: null },
];

/** The queue whose row menu is open: one the current deploy no longer declares. */
const MENU_QUEUE = "sync-contacts";

// TableCell without a link: text-xs, px-3 py-3, the alignment on the cell itself.
// The number columns pass "w-[1%] pl-16": pl-16 wins over the cell's px-3 on the left. A text color
// passed in replaces text-text-dimmed (tailwind-merge), so color() picks one.
const numCell = "table-cell align-middle text-xs py-3 pl-16 pr-3 text-right w-[1%]";
const color = (c: string | false) => c || "text-text-dimmed";
const badge =
  "grid place-items-center border border-border-bright rounded-sm px-1 h-4 text-xxs bg-background-bright whitespace-nowrap";

function HeaderInfo({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-1 justify-end">
      {children}
      <div className="h-fit">
        <I.InformationCircleIcon className="size-3.5 text-text-dimmed flex-0" />
      </div>
    </div>
  );
}

// The dashboard portals the popover; here it sits under its trigger, end-aligned.
const rowMenu = (
  <div className="absolute right-0.5 top-full mt-0.5 z-50 text-left">
    <RowMenuPopover bare>
      <div className="flex flex-col gap-1 p-1">
        {/* QueuePauseResumeButton, variant minimal/small, fullWidth. */}
        <div className="w-full">
          <div className="flex font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 px-2.5 text-xs bg-transparent">
            <div className="relative flex w-full items-center">
              <div className="text-left flex w-full items-center text-text-dimmed gap-x-2.5">
                <PauseSolidIcon className="h-3.5 -mx-1 text-warning shrink-0 justify-start" />
                <span className="mx-auto grow self-center truncate">Pause</span>
              </div>
            </div>
          </div>
        </div>
        <RowMenuItem
          className="h-[1.8rem] px-[0.4rem] text-2sm rounded-sm"
          icon={I.RunsIcon}
          iconClassName="text-runs"
        >
          View all runs
        </RowMenuItem>
        <RowMenuItem
          className="h-[1.8rem] px-[0.4rem] text-2sm rounded-sm"
          icon={I.RectangleStackIcon}
          iconClassName="text-queues"
        >
          View queued runs
        </RowMenuItem>
        <RowMenuItem
          className="h-[1.8rem] px-[0.4rem] text-2sm rounded-sm"
          icon={SpinnerIcon}
          iconClassName="text-queues animate-none"
        >
          View running runs
        </RowMenuItem>
        <RowMenuItem
          className="h-[1.8rem] px-[0.4rem] text-2sm rounded-sm"
          icon={AdjustmentsHorizontalIcon}
        >
          Override limit…
        </RowMenuItem>
        <RowMenuItem
          className="h-[1.8rem] px-[0.4rem] text-2sm rounded-sm"
          icon={ArchiveBoxArrowDownIcon}
          iconClassName="text-text-dimmed"
          mark="archive"
          markBadge="left"
        >
          Archive...
        </RowMenuItem>
      </div>
    </RowMenuPopover>
  </div>
);

function QueueRow({ q }: { q: Queue }) {
  const limit = q.limit ?? ENV_LIMIT;
  const atLimit = limit > 0 && q.running >= limit;
  const dim = q.paused ? "opacity-50" : "";
  const menuOpen = q.name === MENU_QUEUE;
  return (
    <div className={tableRow}>
      <div className={`${td} px-3 py-3 text-left`}>
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            {q.type === "task" ? (
              <I.TasksIcon className={`size-[1.125rem] text-blue-500 ${dim}`} />
            ) : (
              <I.RectangleStackIcon className={`size-[1.125rem] text-purple-500 ${dim}`} />
            )}
            <span className={dim || undefined}>{q.name}</span>
          </span>
          {q.paused && <div className={`${badge} text-warning`}>Paused</div>}
          {atLimit && <div className={`${badge} text-warning`}>At concurrency limit</div>}
        </span>
      </div>
      <div className={`${numCell} ${color(false)} tabular-nums ${dim}`}>{q.queued}</div>
      <div
        className={`${numCell} ${color(atLimit ? "text-warning" : q.running > 0 && "text-text-bright")} tabular-nums ${dim}`}
      >
        {q.running}
      </div>
      <div className={`${numCell} ${color(false)} tabular-nums ${dim}`}>{limit}</div>
      <div className={`${numCell} ${color(atLimit && "text-warning")} ${dim}`}>
        {q.limit ? "User" : "Environment"}
      </div>
      {/* TableCellMenu, sticky. A paused queue keeps its Resume button visible beside the menu. */}
      <div
        className={`${td} text-right sticky right-0 bg-background-dimmed ${menuOpen ? "z-10" : ""}`}
      >
        <div className="relative h-full p-1">
          <div className="absolute right-0 top-1/2 mr-1 flex -translate-y-1/2 items-center justify-end gap-0.5 rounded-[0.25rem] p-0.5 bg-background-dimmed">
            {q.paused && (
              <div>
                <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 px-2.5 text-xs bg-tertiary">
                  <div className="relative flex w-full items-center">
                    <div className="justify-center flex w-full items-center text-text-bright gap-x-2.5">
                      <PlayIcon className="h-3.5 -mx-1 text-success shrink-0 justify-start" />
                      <span className="mx-auto grow self-center truncate">Resume</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div
              data-mark={menuOpen ? "row-menu" : undefined}
              data-mark-badge={menuOpen ? "left" : undefined}
              className={`flex items-center justify-center size-6 rounded-[3px] ${menuOpen ? "text-text-bright" : "text-text-dimmed"}`}
            >
              <I.EllipsisVerticalIcon className="size-5" />
            </div>
            {menuOpen && rowMenu}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ConcurrencyFigure() {
  const queued = queues.reduce((n, q) => n + q.queued, 0);
  const running = queues.reduce((n, q) => n + q.running, 0);
  return (
    <AppFrame menu={<SideMenu active="Concurrency" open={["Observability"]} />}>
      <div className="grid h-full grid-rows-[auto_1fr]">
        <PageHeader title="Concurrency">
          <Button variant="docs" icon={I.BookIcon}>
            Queues docs
          </Button>
        </PageHeader>
        <div className="grid grid-rows-[auto_1fr]">
          <div className="grid grid-cols-3 gap-3 p-3">
            <Tile
              title="Queued"
              accessory={
                <div className="flex items-start gap-1">
                  <div data-mark="pause-env">
                    <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 px-2.5 text-xs bg-secondary border shadow-xs border-warning/60 text-warning">
                      <div className="relative flex w-full items-center">
                        <div className="justify-center flex w-full items-center text-text-bright gap-x-2.5">
                          <PauseSolidIcon className="h-3.5 -mx-1 text-warning shrink-0 justify-start" />
                          <span className="mx-auto grow self-center truncate text-warning">
                            Pause Development environment…
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <RunsLink />
                </div>
              }
            >
              <span>{queued}</span>
            </Tile>
            <Tile title="Running" accessory={<RunsLink />}>
              <span>{running}</span>
            </Tile>
            <Tile
              title="Concurrency limit"
              accessory={
                <Button
                  icon={ArrowUpCircleIcon}
                  iconClassName="-mx-1 text-indigo-500"
                  mark="increase-limit"
                >
                  Increase limit
                </Button>
              }
            >
              <span>{ENV_LIMIT}</span>
              <div className="text-xs tabular-nums">
                <span className="flex items-center gap-1">
                  Burst limit {ENV_LIMIT * 2}
                  <div className="h-fit">
                    <I.InformationCircleIcon className="size-3.5 text-text-dimmed flex-0" />
                  </div>
                </span>
              </div>
            </Tile>
          </div>
          <div className="grid grid-rows-[auto_1fr]">
            <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-1.5 py-1.5">
              <div className="flex items-center gap-2">
                <SearchField placeholder="Search queues…" />
                <SmallSwitch label="Show archived" mark="show-archived" />
              </div>
            </div>
            <div className="flex min-h-0 flex-col">
              {/* overflow-x-auto in the dashboard: the sticky menu column stays at the right edge. */}
              <div className="whitespace-nowrap overflow-hidden min-h-0 flex-1 border-t">
                <div className="table w-full">
                  <div className="table-header-group sticky top-0 z-10 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-grid-bright bg-background-dimmed">
                    <div className={tableRow}>
                      <div className={`${th} text-left`}>Name</div>
                      <div className={`${th} text-right`}>Queued</div>
                      <div className={`${th} text-right`}>Running</div>
                      <div className={`${th} text-right`}>
                        <HeaderInfo>Limit</HeaderInfo>
                      </div>
                      <div className={`${th} text-right`}>
                        <HeaderInfo>Limited by</HeaderInfo>
                      </div>
                      <div className={`${th} text-left w-[1%] pl-32`} />
                    </div>
                  </div>
                  <div className="table-row-group relative">
                    {queues.map((q) => (
                      <QueueRow key={q.name} q={q} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppFrame>
  );
}
