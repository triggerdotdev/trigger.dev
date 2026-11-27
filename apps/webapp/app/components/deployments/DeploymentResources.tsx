import { ChevronRightIcon, DocumentTextIcon } from "@heroicons/react/20/solid";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { sanitizeQueueName } from "@trigger.dev/core/v3/isomorphic";
import { type ReactNode, useId, useState } from "react";
import { AIPenIcon } from "~/assets/icons/AIPenIcon";
import { ConcurrencyIcon } from "~/assets/icons/ConcurrencyIcon";
import { MachineDefaultIcon } from "~/assets/icons/MachineIcon";
import { QueuesIcon } from "~/assets/icons/QueuesIcon";
import { ScheduleIcon } from "~/assets/icons/ScheduleIcon";
import { TasksIcon } from "~/assets/icons/TasksIcon";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { Badge } from "~/components/primitives/Badge";
import { DeferredContent } from "~/components/primitives/detail/DeferredContent";
import {
  DetailSection,
  DetailSectionHeading,
  SkeletonBone,
} from "~/components/primitives/detail/DetailSections";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import type {
  DeploymentPrompts,
  DeploymentResourceItems,
  ResourceChange,
} from "~/presenters/v3/DeploymentOverviewPresenter.server";
import { cn } from "~/utils/cn";
import { formatNumber } from "~/utils/numberFormatter";

export type { DeploymentResourceItems } from "~/presenters/v3/DeploymentOverviewPresenter.server";

/** Counts of everything a version registers when it's indexed. */
export type ResourceCounts = {
  tasks: number;
  scheduled: number;
  agents: number;
  webhookTasks: number;
  queues: number;
  concurrencyLimits: number;
  declaredSchedules: number;
  webhookEndpoints: number;
  webhookSubscribers: number;
  machinePresets: number;
  files: number;
};

type RowId =
  | "tasks"
  | "queues"
  | "concurrencyLimits"
  | "schedules"
  | "webhooks"
  | "prompts"
  | "machines"
  | "files";

type TaskFilter = "ALL" | DeploymentResourceItems["tasks"][number]["triggerSource"];

const TASK_FILTERS: { id: TaskFilter; label: string; count: (c: ResourceCounts) => number }[] = [
  { id: "ALL", label: "All", count: (c) => c.tasks },
  {
    id: "STANDARD",
    label: "Standard",
    count: (c) => c.tasks - c.scheduled - c.agents - c.webhookTasks,
  },
  { id: "SCHEDULED", label: "Scheduled", count: (c) => c.scheduled },
  { id: "WEBHOOK", label: "Webhook", count: (c) => c.webhookTasks },
  { id: "AGENT", label: "Agent", count: (c) => c.agents },
];

/** Rows shown before "Show all", so a big project doesn't push the rest of Overview away. */
const PREVIEW_ROWS = 10;
/** Lines the first column up under the row's name: padding, chevron, icon and their gaps. */
const INDENT = "pl-16";

/**
 * What a version registered when it was indexed: one row per kind with counts by subtype and the
 * change since the previous version. A row with items expands into a table of them. Every kind is
 * listed in a fixed order; one this version has none of shows a dimmed 0. The prompts arrive
 * after the rest (a deferred loader value), so their row shows a placeholder until they do.
 */
export function DeploymentResources({
  counts,
  previous,
  items,
  prompts,
  taskPath,
}: {
  counts: ResourceCounts;
  previous?: ResourceCounts;
  items: DeploymentResourceItems;
  prompts: Promise<DeploymentPrompts>;
  /** Runs of a task on this version. */
  taskPath?: (slug: string) => string;
}) {
  const [open, setOpen] = useState<Set<RowId>>(() => new Set());
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("ALL");
  const toggle = (id: RowId, value?: boolean) =>
    setOpen((current) => {
      const next = new Set(current);
      if (value ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  const none = (...kinds: (keyof ResourceCounts)[]) => kinds.every((kind) => counts[kind] === 0);
  const diff = (kind: keyof ResourceCounts) =>
    previous ? diffOf(counts[kind], previous[kind]) : undefined;
  const changes = <T extends { change: ResourceChange }>(list: T[]) =>
    previous
      ? {
          added: list.filter((i) => i.change === "added").length,
          removed: list.filter((i) => i.change === "removed").length,
        }
      : undefined;

  const visibleTasks =
    taskFilter === "ALL"
      ? items.tasks
      : items.tasks.filter((task) => task.triggerSource === taskFilter);

  // A kind chip only says something when there's more than one kind.
  const kinds = TASK_FILTERS.filter((f) => f.id !== "ALL" && f.count(counts) > 0);
  const taskChips =
    kinds.length > 1
      ? TASK_FILTERS.filter((f) => f.id === "ALL" || kinds.includes(f))
      : TASK_FILTERS.slice(0, 1);

  const promptsRow = (loaded: DeploymentPrompts | undefined): ResourceRowProps => ({
    id: "prompts",
    icon: <AIPenIcon className="size-4 text-aiPrompts" />,
    title: "Prompts",
    tooltip:
      "Prompts whose text, model or config changed in this deploy, each a new prompt version.",
    chips: [{ label: "Updated", count: loaded?.length ?? 0 }],
    content: !!loaded?.length && (
      <ItemTable
        items={loaded.map((p) => ({ ...p, change: null }))}
        noun="prompts"
        columns={PROMPT_COLUMNS}
      />
    ),
    none: loaded?.length === 0,
    loading: !loaded,
  });

  const rows: (ResourceRowProps | "prompts")[] = [
    {
      id: "tasks",
      icon: <TasksIcon className="size-4 text-tasks" />,
      title: "Tasks",
      changes: changes(items.tasks),
      chips: taskChips.map((f) => ({
        label: f.label,
        count: f.count(counts),
        active: open.has("tasks") && taskFilter === f.id,
        onClick: () => {
          setTaskFilter(f.id);
          toggle("tasks", true);
        },
      })),
      none: none("tasks"),
      content: (
        <TasksTable tasks={visibleTasks} taskPath={taskPath} filtered={taskFilter !== "ALL"} />
      ),
    },
    {
      id: "queues",
      icon: <QueuesIcon className="size-4 text-queues" />,
      title: "Queues",
      changes: changes(items.queues) ?? diff("queues"),
      chips: [{ count: counts.queues }],
      content: items.queues.length > 0 && (
        <ItemTable items={items.queues} noun="queues" columns={QUEUE_COLUMNS} />
      ),
      none: none("queues"),
    },
    {
      id: "concurrencyLimits",
      icon: <ConcurrencyIcon className="size-4 text-text-dimmed" />,
      title: "Concurrency limits",
      changes: changes(items.concurrencyLimits) ?? diff("concurrencyLimits"),
      chips: [{ count: counts.concurrencyLimits }],
      content: items.concurrencyLimits.length > 0 && (
        <ItemTable items={items.concurrencyLimits} noun="limits" columns={LIMIT_COLUMNS} />
      ),
      none: none("concurrencyLimits"),
    },
    {
      id: "schedules",
      icon: <ScheduleIcon className="size-4 text-schedules" />,
      title: "Schedules in code",
      tooltip:
        "Cron schedules declared on tasks. Schedules added in the dashboard or API aren't counted.",
      changes: changes(items.schedules) ?? diff("declaredSchedules"),
      chips: [{ count: counts.declaredSchedules }],
      content: items.schedules.length > 0 && (
        <ItemTable items={items.schedules} noun="schedules" columns={SCHEDULE_COLUMNS} />
      ),
      none: none("declaredSchedules"),
    },
    {
      id: "webhooks",
      icon: <WebhookIcon className="size-4 text-webhooks" />,
      title: "Webhooks",
      changes: changes(items.webhookEndpoints) ?? diff("webhookEndpoints"),
      chips: [
        { label: "Endpoints", count: counts.webhookEndpoints },
        { label: "Subscribers", count: counts.webhookSubscribers },
      ],
      content: items.webhookEndpoints.length > 0 && (
        <ItemTable items={items.webhookEndpoints} noun="endpoints" columns={ENDPOINT_COLUMNS} />
      ),
      none: none("webhookEndpoints", "webhookSubscribers"),
    },
    "prompts",
    {
      id: "machines",
      icon: <MachineDefaultIcon className="size-4 text-text-dimmed" />,
      title: "Machines",
      tooltip: "Machine presets set on tasks. Default is the project's default machine.",
      chips: items.machines.map((m) => ({ label: m.name ?? "Default", count: m.tasks })),
      none: items.machines.length === 0,
    },
    {
      id: "files",
      icon: <DocumentTextIcon className="size-4 text-text-dimmed" />,
      title: "Task files",
      changes: diff("files"),
      chips: [{ count: counts.files }],
      none: none("files"),
    },
  ];

  return (
    <DetailSection>
      <DetailSectionHeading title="Resources" />
      <div className="-mx-4 border-y border-grid-bright">
        {rows.map((row) => {
          const render = (props: ResourceRowProps) => (
            <ResourceRow
              key={props.id}
              {...props}
              isOpen={open.has(props.id)}
              onToggle={() => toggle(props.id)}
            />
          );
          return row === "prompts" ? (
            <DeferredContent
              key="prompts"
              resolve={prompts}
              retainKey="prompts"
              fallback={render(promptsRow(undefined))}
              errorElement={render(promptsRow([]))}
            >
              {(loaded) => render(promptsRow(loaded))}
            </DeferredContent>
          ) : (
            render(row)
          );
        })}
      </div>
    </DetailSection>
  );
}

type Chip = { label?: string; count: number; active?: boolean; onClick?: () => void };

type ResourceRowProps = {
  id: RowId;
  icon: ReactNode;
  title: string;
  tooltip?: string;
  changes?: { added: number; removed: number };
  chips: Chip[];
  /** The expanded table; a row without one has no chevron. */
  content?: ReactNode;
  /** This version has none of the kind: a dimmed 0 instead of chips, and no expanding. */
  none?: boolean;
  /** The kind's data hasn't arrived: a placeholder instead of chips, and no expanding. */
  loading?: boolean;
};

function ResourceRow({
  icon,
  title,
  tooltip,
  changes,
  chips,
  content,
  none,
  loading,
  isOpen,
  onToggle,
}: ResourceRowProps & { isOpen: boolean; onToggle: () => void }) {
  const contentId = useId();
  // A kind this deploy removed entirely still lists what it removed.
  const expandable = !loading && !!content && (!none || (changes?.removed ?? 0) > 0);
  const heading = (
    <>
      {expandable ? (
        <ChevronRightIcon
          className={cn(
            "size-4 flex-none text-text-faint transition-transform duration-150 group-hover/row:text-text-dimmed",
            isOpen && "rotate-90"
          )}
        />
      ) : (
        <span className="size-4 flex-none" />
      )}
      <span className="flex size-4 flex-none items-center justify-center">{icon}</span>
      {tooltip ? (
        <SimpleTooltip
          button={
            <span
              className={cn("truncate text-sm", none ? "text-text-dimmed" : "text-text-bright")}
            >
              {title}
            </span>
          }
          content={tooltip}
          disableHoverableContent
          // The row is already a button; a nested <button> breaks hydration.
          asChild
        />
      ) : (
        <span className={cn("truncate text-sm", none ? "text-text-dimmed" : "text-text-bright")}>
          {title}
        </span>
      )}
      <ChangeCounts changes={changes} />
    </>
  );

  return (
    <div className="border-b border-grid-dimmed last:border-b-0">
      <div className="group/row flex h-10 items-center gap-3 pr-4 hover:bg-background-bright">
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isOpen}
            aria-controls={contentId}
            className="flex h-full min-w-0 flex-1 items-center gap-2 pl-4 text-left focus-custom"
          >
            {heading}
          </button>
        ) : (
          <div className="flex h-full min-w-0 flex-1 items-center gap-2 pl-4">{heading}</div>
        )}
        <div className="flex flex-none items-center gap-1">
          {loading ? (
            <SkeletonBone className="w-14" />
          ) : none ? (
            <span className="px-2 text-xs tabular-nums text-text-faint">0</span>
          ) : (
            chips.map((chip, index) => <CountChip key={chip.label ?? index} {...chip} />)
          )}
        </div>
      </div>
      {expandable && isOpen ? (
        <div id={contentId} className="border-t border-grid-dimmed">
          {content}
        </div>
      ) : null}
    </div>
  );
}

function ChangeCounts({ changes }: { changes?: { added: number; removed: number } }) {
  if (!changes || (changes.added === 0 && changes.removed === 0)) return null;
  return (
    <span className="flex items-center gap-1 text-xs font-medium tabular-nums">
      {changes.added > 0 ? <span className="text-success">+{changes.added}</span> : null}
      {changes.removed > 0 ? <span className="text-warning">−{changes.removed}</span> : null}
    </span>
  );
}

function CountChip({ label, count, active, onClick }: Chip) {
  const className = cn(
    "inline-flex h-5 items-center gap-1 rounded-full border px-2 text-xs tabular-nums transition-colors",
    active
      ? "border-border-bright bg-background-hover text-text-bright"
      : "border-grid-bright text-text-dimmed",
    onClick && !active && "hover:border-border-bright hover:text-text-bright"
  );
  const body = label ? (
    <>
      {label}
      <span className={cn(active ? "text-text-bright" : "text-text-faint")}>
        {formatNumber(count)}
      </span>
    </>
  ) : (
    formatNumber(count)
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(className, "focus-custom")}
    >
      {body}
    </button>
  ) : (
    <span className={className}>{body}</span>
  );
}

function TasksTable({
  tasks,
  taskPath,
  filtered,
}: {
  tasks: DeploymentResourceItems["tasks"];
  taskPath?: (slug: string) => string;
  filtered: boolean;
}) {
  return (
    <ItemTable
      items={tasks}
      noun="tasks"
      empty={filtered ? "No tasks of this kind" : "No tasks in this version"}
      rowPath={(task) => (task.change === "removed" ? undefined : taskPath?.(task.slug))}
      columns={TASK_COLUMNS}
    />
  );
}

type Column<T> = {
  label: string;
  alignment?: "left" | "right";
  renderCell: (item: T) => ReactNode;
};

/** A kind's items as a dense table, its first column lined up under the row's name. */
function ItemTable<T extends { change: ResourceChange }>({
  items,
  columns,
  noun,
  empty,
  rowPath,
}: {
  items: T[];
  columns: Column<T>[];
  noun: string;
  empty?: string;
  rowPath?: (item: T) => string | undefined;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, PREVIEW_ROWS);
  const hidden = items.length - shown.length;

  return (
    <>
      <Table variant="dimmed" showTopBorder={false}>
        <TableHeader>
          <TableRow>
            {columns.map((column, index) => (
              <TableHeaderCell
                key={column.label}
                alignment={column.alignment}
                className={cn(
                  "px-2 py-2 text-xs",
                  index === 0 && INDENT,
                  index === columns.length - 1 && "pr-4"
                )}
              >
                {column.label}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className={INDENT}>
                <span className="text-text-faint">{empty ?? `No ${noun}`}</span>
              </TableCell>
            </TableRow>
          ) : (
            shown.map((item, rowIndex) => {
              const to = rowPath?.(item);
              const removed = item.change === "removed";
              return (
                <TableRow key={rowIndex} className={cn(removed && "opacity-60")}>
                  {columns.map((column, index) => {
                    const first = index === 0;
                    const last = index === columns.length - 1;
                    const pad = cn("px-2 py-2", first && INDENT, last && "pr-4");
                    return (
                      <TableCell
                        key={column.label}
                        to={to}
                        isTabbableCell={first && !!to}
                        alignment={column.alignment}
                        className={to ? undefined : pad}
                        actionClassName={to ? pad : undefined}
                      >
                        {first ? (
                          <span className="flex items-center gap-2">
                            {column.renderCell(item)}
                            {item.change === "added" ? (
                              <Badge variant="extra-small">New</Badge>
                            ) : removed ? (
                              <Badge variant="extra-small" className="text-text-dimmed">
                                Removed
                              </Badge>
                            ) : null}
                          </span>
                        ) : (
                          column.renderCell(item)
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      {hidden > 0 ? (
        <div className={cn("flex h-8 items-center gap-2 pr-4 text-xs", INDENT)}>
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-text-link hover:underline focus-custom"
          >
            Show {formatNumber(hidden)} more {noun}
          </button>
        </div>
      ) : null}
    </>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-text-bright">{children}</span>;
}

/** A long id cut to `width`, whole in its tooltip. */
function TruncatedMono({ children, width }: { children: string; width: string }) {
  return (
    <span
      title={children}
      className={cn("block truncate font-mono text-xs text-text-bright", width)}
    >
      {children}
    </span>
  );
}

/** A file path cut from the left, so the file name stays visible. */
function FilePath({ path, width }: { path: string; width: string }) {
  return (
    <span title={path} className={cn("block truncate text-left [direction:rtl]", width)}>
      {/* The bdi keeps the leading "src/" from being reordered by the rtl direction. */}
      <bdi>{path}</bdi>
    </span>
  );
}

function Faint({ children }: { children: ReactNode }) {
  return <span className="text-text-faint">{children}</span>;
}

/** Up to three task ids, then how many more. */
function TaskList({ tasks }: { tasks: string[] }) {
  if (tasks.length === 0) return <Faint>None</Faint>;
  const shown = tasks.slice(0, 3);
  return (
    <span className="block max-w-72 truncate">
      <span className="font-mono">{shown.join(", ")}</span>
      {tasks.length > shown.length ? ` +${tasks.length - shown.length} more` : null}
    </span>
  );
}

function diffOf(value: number, before: number) {
  if (value === before) return undefined;
  return value > before
    ? { added: value - before, removed: 0 }
    : { added: 0, removed: before - value };
}

// Column renderers per kind, at module level so they aren't recreated on every render.

const QUEUE_COLUMNS: Column<DeploymentResourceItems["queues"][number]>[] = [
  { label: "Queue", renderCell: (q) => <TruncatedMono width="max-w-56">{q.name}</TruncatedMono> },
  {
    // Queue rows are shared by every version, so this is the limit now, not at deploy time.
    label: "Current limit",
    alignment: "right",
    renderCell: (q) =>
      q.concurrencyLimit === null ? (
        <span className="text-text-faint">Environment limit</span>
      ) : (
        formatNumber(q.concurrencyLimit)
      ),
  },
  { label: "Tasks", renderCell: (q) => <TaskList tasks={q.tasks} /> },
];

const LIMIT_COLUMNS: Column<DeploymentResourceItems["concurrencyLimits"][number]>[] = [
  { label: "Limit", renderCell: (l) => <Mono>{l.name}</Mono> },
  {
    label: "Current limit",
    alignment: "right",
    renderCell: (l) =>
      l.concurrencyLimit === null ? (
        <span className="text-text-faint">None</span>
      ) : (
        formatNumber(l.concurrencyLimit)
      ),
  },
  { label: "Tasks", renderCell: (l) => <TaskList tasks={l.tasks} /> },
];

const SCHEDULE_COLUMNS: Column<DeploymentResourceItems["schedules"][number]>[] = [
  { label: "Task", renderCell: (s) => <TruncatedMono width="max-w-48">{s.taskId}</TruncatedMono> },
  { label: "Cron", renderCell: (s) => <Mono>{s.cron}</Mono> },
  { label: "Timezone", alignment: "right", renderCell: (s) => s.timezone },
];

const ENDPOINT_COLUMNS: Column<DeploymentResourceItems["webhookEndpoints"][number]>[] = [
  { label: "Endpoint", renderCell: (e) => <Mono>{e.id}</Mono> },
  { label: "Source", renderCell: (e) => e.source ?? <Faint>Declared elsewhere</Faint> },
  {
    label: "File",
    renderCell: (e) => (e.filePath ? <FilePath path={e.filePath} width="max-w-56" /> : "–"),
  },
  { label: "Subscribers", renderCell: (e) => <TaskList tasks={e.subscribers} /> },
];

const PROMPT_COLUMNS: Column<DeploymentPrompts[number]>[] = [
  { label: "Prompt", renderCell: (p) => <Mono>{p.slug}</Mono> },
  { label: "New version", alignment: "right", renderCell: (p) => `v${p.version}` },
  {
    label: "Model",
    alignment: "right",
    renderCell: (p) => p.model ?? <Faint>Default</Faint>,
  },
];

const TASK_COLUMNS: Column<DeploymentResourceItems["tasks"][number]>[] = [
  { label: "Task", renderCell: (t) => <TruncatedMono width="max-w-40">{t.slug}</TruncatedMono> },
  {
    label: "File",
    renderCell: (t) => <FilePath path={t.filePath} width="max-w-28" />,
  },
  {
    label: "Queue",
    // A task without a queue of its own name gets task/<id> (sanitized, so "ai.x" becomes
    // "task/aix"); that's noise in this table.
    renderCell: (t) =>
      t.queue === null || t.queue === sanitizeQueueName(`task/${t.slug}`) ? (
        <Faint>Own queue</Faint>
      ) : (
        <span className="block max-w-32 truncate">{t.queue}</span>
      ),
  },
  {
    label: "Machine",
    renderCell: (t) => t.machine ?? <Faint>Default</Faint>,
  },
  {
    label: "Max duration",
    alignment: "right",
    renderCell: (t) =>
      t.maxDurationSeconds === null ? (
        <Faint>–</Faint>
      ) : (
        formatDurationMilliseconds(t.maxDurationSeconds * 1000, { style: "short" })
      ),
  },
  {
    label: "Attempts",
    alignment: "right",
    renderCell: (t) => (t.maxAttempts === null ? <Faint>–</Faint> : t.maxAttempts),
  },
];
