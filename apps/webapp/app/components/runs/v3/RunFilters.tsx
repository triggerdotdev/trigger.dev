import * as Ariakit from "@ariakit/react";
import {
  CalendarIcon,
  ClockIcon,
  FingerPrintIcon,
  PlusIcon,
  RectangleStackIcon,
  Squares2X2Icon,
  TagIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { Form, useFetcher } from "@remix-run/react";
import { IconBugFilled, IconRotateClockwise2, IconToggleLeft } from "@tabler/icons-react";
import { MachinePresetName } from "@trigger.dev/core/v3";
import type { BulkActionType, TaskRunStatus, TaskTriggerSource } from "@trigger.dev/database";
import { matchSorter } from "match-sorter";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { MachineDefaultIcon } from "~/assets/icons/MachineIcon";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import {
  formatMachinePresetName,
  MachineLabelCombo,
  machines,
} from "~/components/MachineLabelCombo";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Badge } from "~/components/primitives/Badge";
import { DateTime } from "~/components/primitives/DateTime";
import { MiddleTruncate } from "~/components/primitives/MiddleTruncate";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ComboBox,
  SelectButtonItem,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
  shortcutFromIndex,
} from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import { Switch } from "~/components/primitives/Switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { useDebounceEffect } from "~/hooks/useDebounce";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { type loader as tagsLoader } from "~/routes/resources.environments.$envId.runs.tags";
import { type loader as queuesLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.queues";
import { type loader as versionsLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.versions";
import { Button } from "../../primitives/Buttons";
import { AIFilterInput } from "./AIFilterInput";
import { BulkActionTypeCombo } from "./BulkAction";
import {
  IdFilterDropdown,
  type IdFilterDropdownProps,
  appliedSummary,
  FilterMenuProvider,
  TimeFilter,
  timeFilters,
} from "./SharedFilters";
import {
  allTaskRunStatuses,
  descriptionForTaskRunStatus,
  filterableTaskRunStatuses,
  runStatusTitle,
  TaskRunStatusCombo,
} from "./TaskRunStatus";
import { TaskTriggerSourceIcon } from "./TaskTriggerSource";

export const RunStatus = z.enum(allTaskRunStatuses);

const StringOrStringArray = z.preprocess((value) => {
  if (typeof value === "string") {
    if (value.length > 0) {
      return [value];
    }

    return undefined;
  }

  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === "string" && v.length > 0);
  }

  return undefined;
}, z.string().array().optional());

export const MachinePresetOrMachinePresetArray = z.preprocess((value) => {
  if (typeof value === "string") {
    if (value.length > 0) {
      const parsed = MachinePresetName.safeParse(value);
      return parsed.success ? [parsed.data] : undefined;
    }

    return undefined;
  }

  if (Array.isArray(value)) {
    return value
      .filter((v) => typeof v === "string" && v.length > 0)
      .map((v) => MachinePresetName.safeParse(v))
      .filter((result) => result.success)
      .map((result) => result.data);
  }

  return undefined;
}, MachinePresetName.array().optional());

export const TaskRunListSearchFilters = z.object({
  cursor: z.string().optional().describe("Cursor for pagination - used internally for navigation"),
  direction: z
    .enum(["forward", "backward"])
    .optional()
    .describe("Pagination direction - forward or backward. Used internally for navigation"),
  environments: StringOrStringArray.describe(
    "Environment names to filter by (DEVELOPMENT, STAGING, PREVIEW, PRODUCTION)"
  ),
  tasks: StringOrStringArray.describe(
    "Task identifiers to filter by (these are user-defined names)"
  ),
  versions: StringOrStringArray.describe(
    "Version identifiers to filter by (these are in this format 20250718.1). Needs to be looked up."
  ),
  statuses: z
    .preprocess((value) => {
      if (typeof value === "string") {
        if (value.length > 0) {
          return [value];
        }

        return undefined;
      }

      if (Array.isArray(value)) {
        return value.filter((v) => typeof v === "string" && v.length > 0);
      }

      return undefined;
    }, RunStatus.array().optional())
    .describe(`Run statuses to filter by (${filterableTaskRunStatuses.join(", ")})`),
  tags: StringOrStringArray.describe("Tag names to filter by (these are user-defined names)"),
  bulkId: z
    .string()
    .optional()
    .describe("Bulk action ID to filter by - shows runs from a specific bulk operation"),
  period: z
    .preprocess((value) => (value === "all" ? undefined : value), z.string().optional())
    .describe("Time period string (e.g., '1h', '7d', '30d', '1y') for relative time filtering"),
  from: z.coerce
    .number()
    .optional()
    .describe("Unix timestamp for start of time range - absolute time filtering"),
  to: z.coerce
    .number()
    .optional()
    .describe("Unix timestamp for end of time range - absolute time filtering"),
  rootOnly: z.coerce
    .boolean()
    .optional()
    .describe("Show only root runs (not child runs) - set to true to exclude sub-runs"),
  batchId: z
    .string()
    .optional()
    .describe(
      "Batch ID to filter by - shows runs from a specific batch operation. They start with batch_"
    ),
  runId: StringOrStringArray.describe("Specific run IDs to filter by. They start with run_"),
  scheduleId: z
    .string()
    .optional()
    .describe(
      "Schedule ID to filter by - shows runs from a specific schedule. They start with sched_"
    ),
  queues: StringOrStringArray.describe("Queue names to filter by (these are user-defined names)"),
  machines: MachinePresetOrMachinePresetArray.describe(
    `Machine presets to filter by (${machines.join(", ")})`
  ),
  errorId: z.string().optional().describe("Error ID to filter runs by (e.g. error_abc123)"),
});

export type TaskRunListSearchFilters = z.infer<typeof TaskRunListSearchFilters>;
export type TaskRunListSearchFilterKey = keyof TaskRunListSearchFilters;

export function filterTitle(filterKey: string) {
  switch (filterKey) {
    case "cursor":
      return "Cursor";
    case "direction":
      return "Direction";
    case "statuses":
      return "Status";
    case "tasks":
      return "Tasks";
    case "tags":
      return "Tags";
    case "bulkId":
      return "Bulk action";
    case "period":
      return "Period";
    case "from":
      return "From";
    case "to":
      return "To";
    case "rootOnly":
      return "Root only";
    case "batchId":
      return "Batch ID";
    case "runId":
      return "Run ID";
    case "scheduleId":
      return "Schedule ID";
    case "queues":
      return "Queues";
    case "machines":
      return "Machine";
    case "versions":
      return "Version";
    case "errorId":
      return "Error ID";
    default:
      return filterKey;
  }
}

export function filterIcon(filterKey: string): ReactNode | undefined {
  switch (filterKey) {
    case "cursor":
    case "direction":
      return undefined;
    case "statuses":
      return <StatusIcon className="size-4 border-text-bright" />;
    case "tasks":
      return <TaskIcon className="size-4" />;
    case "tags":
      return <TagIcon className="size-4" />;
    case "bulkId":
      return <ListCheckedIcon className="size-4" />;
    case "period":
      return <CalendarIcon className="size-4" />;
    case "from":
      return <CalendarIcon className="size-4" />;
    case "to":
      return <CalendarIcon className="size-4" />;
    case "rootOnly":
      return <IconToggleLeft className="size-4" />;
    case "batchId":
      return <Squares2X2Icon className="size-4" />;
    case "runId":
      return <FingerPrintIcon className="size-4" />;
    case "scheduleId":
      return <ClockIcon className="size-4" />;
    case "queues":
      return <RectangleStackIcon className="size-4" />;
    case "machines":
      return <MachineDefaultIcon className="size-4" />;
    case "versions":
      return <IconRotateClockwise2 className="size-4" />;
    case "errorId":
      return <IconBugFilled className="size-4" />;
    default:
      return undefined;
  }
}

export function getRunFiltersFromSearchParams(
  searchParams: URLSearchParams
): TaskRunListSearchFilters {
  const params = {
    cursor: searchParams.get("cursor") ?? undefined,
    direction: searchParams.get("direction") ?? undefined,
    statuses:
      searchParams.getAll("statuses").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("statuses")
        : undefined,
    tasks:
      searchParams.getAll("tasks").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("tasks")
        : undefined,
    period: searchParams.get("period") ?? undefined,
    bulkId: searchParams.get("bulkId") ?? undefined,
    tags:
      searchParams.getAll("tags").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("tags")
        : undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    rootOnly: searchParams.has("rootOnly") ? searchParams.get("rootOnly") === "true" : undefined,
    runId:
      searchParams.getAll("runId").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("runId")
        : undefined,
    batchId: searchParams.get("batchId") ?? undefined,
    scheduleId: searchParams.get("scheduleId") ?? undefined,
    queues:
      searchParams.getAll("queues").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("queues")
        : undefined,
    machines:
      searchParams.getAll("machines").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("machines")
        : undefined,
    versions:
      searchParams.getAll("versions").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("versions")
        : undefined,
    errorId: searchParams.get("errorId") ?? undefined,
  };

  const parsed = TaskRunListSearchFilters.safeParse(params);

  if (!parsed.success) {
    return {};
  }

  return parsed.data;
}

type RunFiltersProps = {
  possibleTasks: { slug: string; triggerSource: TaskTriggerSource; isInLatestDeployment: boolean }[];
  bulkActions: {
    id: string;
    type: BulkActionType;
    createdAt: Date;
    name: string;
  }[];
  rootOnlyDefault: boolean;
  hasFilters: boolean;
  /** Hide the AI search input (useful when replacing with a custom search component) */
  hideSearch?: boolean;
  /** Custom default period for the time filter (e.g., "1h", "7d") */
  defaultPeriod?: string;
};

export function RunsFilters(props: RunFiltersProps) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("statuses") ||
    searchParams.has("tasks") ||
    searchParams.has("bulkId") ||
    searchParams.has("tags") ||
    searchParams.has("batchId") ||
    searchParams.has("runId") ||
    searchParams.has("scheduleId") ||
    searchParams.has("queues") ||
    searchParams.has("machines") ||
    searchParams.has("versions") ||
    searchParams.has("errorId");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1.5">
      {!props.hideSearch && <AIFilterInput />}
      <PermanentStatusFilter />
      <PermanentTasksFilter possibleTasks={props.possibleTasks} />
      <TimeFilter defaultPeriod={props.defaultPeriod} shortcut={{ key: "d" }} />
      <RootOnlyToggle defaultValue={props.rootOnlyDefault} />
      <AppliedFilters {...props} />
      <FilterMenu {...props} />
      {hasFilters && (
        <Form className="-ml-1 h-6">
          <Button
            variant="minimal/small"
            LeadingIcon={XMarkIcon}
            tooltip="Clear all filters"
            className="group-hover/button:bg-transparent"
            leadingIconClassName="group-hover/button:text-text-bright"
          />
        </Form>
      )}
    </div>
  );
}

const filterTypes = [
  { name: "tags", title: "Tags", icon: <TagIcon className="size-4" /> },
  { name: "versions", title: "Versions", icon: <IconRotateClockwise2 className="size-4" /> },
  { name: "queues", title: "Queues", icon: <RectangleStackIcon className="size-4" /> },
  { name: "machines", title: "Machines", icon: <MachineDefaultIcon className="size-4" /> },
  { name: "run", title: "Run ID", icon: <FingerPrintIcon className="size-4" /> },
  { name: "batch", title: "Batch ID", icon: <Squares2X2Icon className="size-4" /> },
  { name: "schedule", title: "Schedule ID", icon: <ClockIcon className="size-4" /> },
  { name: "bulk", title: "Bulk action", icon: <ListCheckedIcon className="size-4" /> },
  { name: "error", title: "Error ID", icon: <IconBugFilled className="size-4" /> },
] as const;

type FilterType = (typeof filterTypes)[number]["name"];

const shortcut = { key: "f" };

function FilterMenu(props: RunFiltersProps) {
  const [filterType, setFilterType] = useState<FilterType | undefined>();

  const filterTrigger = (
    <SelectTrigger
      icon={
        <div className="flex size-4 items-center justify-center">
          <PlusIcon className="size-3.5" />
        </div>
      }
      variant={"secondary/small"}
      shortcut={shortcut}
      tooltipTitle={"More filters"}
      className="pl-1 pr-2"
    >
      More filters
    </SelectTrigger>
  );

  return (
    <FilterMenuProvider onClose={() => setFilterType(undefined)}>
      {(search, setSearch) => (
        <Menu
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          trigger={filterTrigger}
          filterType={filterType}
          setFilterType={setFilterType}
          {...props}
        />
      )}
    </FilterMenuProvider>
  );
}

function AppliedFilters({ bulkActions }: RunFiltersProps) {
  return (
    <>
      <AppliedTagsFilter />
      <AppliedVersionsFilter />
      <AppliedQueuesFilter />
      <AppliedMachinesFilter />
      <AppliedRunIdFilter />
      <AppliedBatchIdFilter />
      <AppliedScheduleIdFilter />
      <AppliedBulkActionsFilter bulkActions={bulkActions} />
      <AppliedErrorIdFilter />
    </>
  );
}

type MenuProps = {
  searchValue: string;
  clearSearchValue: () => void;
  trigger: React.ReactNode;
  filterType: FilterType | undefined;
  setFilterType: (filterType: FilterType | undefined) => void;
} & RunFiltersProps;

function Menu(props: MenuProps) {
  switch (props.filterType) {
    case undefined:
      return <MainMenu {...props} />;
    case "bulk":
      return <BulkActionsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "tags":
      return <TagsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "queues":
      return <QueuesDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "machines":
      return <MachinesDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "run":
      return <RunIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "batch":
      return <BatchIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "schedule":
      return <ScheduleIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "versions":
      return <VersionsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "error":
      return <ErrorIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
  }
}

function MainMenu({ searchValue, trigger, clearSearchValue, setFilterType }: MenuProps) {
  const filtered = useMemo(() => {
    return filterTypes.filter((item) => {
      return item.title.toLowerCase().includes(searchValue.toLowerCase());
    });
  }, [searchValue]);

  return (
    <SelectProvider virtualFocus={true}>
      {trigger}
      <SelectPopover>
        <ComboBox placeholder={"Filter by..."} shortcut={shortcut} value={searchValue} />
        <SelectList>
          {filtered.map((type, index) => (
            <SelectButtonItem
              key={type.name}
              onClick={() => {
                clearSearchValue();
                setFilterType(type.name);
              }}
              icon={type.icon}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <span className="text-text-bright">{type.title}</span>
            </SelectButtonItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

const statuses = filterableTaskRunStatuses.map((status) => ({
  title: runStatusTitle(status),
  value: status,
}));

function StatusDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ statuses: values, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    return statuses.filter((item) => item.title.toLowerCase().includes(searchValue.toLowerCase()));
  }, [searchValue]);

  return (
    <SelectProvider value={values("statuses")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox placeholder={"Filter by status..."} value={searchValue} />
        <SelectList>
          {filtered.map((item, index) => (
            <SelectItem
              key={item.value}
              value={item.value}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger className="group flex w-full flex-col py-0">
                    <TaskRunStatusCombo status={item.value} iconClassName="animate-none" />
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={50}>
                    <Paragraph variant="extra-small">
                      {descriptionForTaskRunStatus(item.value)}
                    </Paragraph>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

const statusShortcut = { key: "s" };

function PermanentStatusFilter() {
  const { values, del } = useSearchParams();
  const statuses = values("statuses");
  const hasStatuses = statuses.length > 0 && !statuses.every((v) => v === "");
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: statusShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <StatusDropdown
          trigger={
            <Ariakit.TooltipProvider timeout={200}>
              <Ariakit.TooltipAnchor
                render={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  <Ariakit.Select
                    ref={triggerRef as any}
                    render={<div className="group cursor-pointer focus-custom" />}
                  />
                }
              >
                {hasStatuses ? (
                  <AppliedFilter
                    label="Status"
                    icon={filterIcon("statuses")}
                    value={appliedSummary(statuses.map((v) => runStatusTitle(v as TaskRunStatus)))}
                    onRemove={() => del(["statuses", "cursor", "direction"])}
                    variant="secondary/small"
                    className="pl-1"
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                    <div className="grid size-4 place-items-center">
                      <div className="size-[75%] rounded-full border-2 border-text-bright" />
                    </div>
                    <span>Status</span>
                  </div>
                )}
              </Ariakit.TooltipAnchor>
              <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span>Filter by status</span>
                  <ShortcutKey
                    className="size-4 flex-none"
                    shortcut={statusShortcut}
                    variant="small"
                  />
                </div>
              </Ariakit.Tooltip>
            </Ariakit.TooltipProvider>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function TasksDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
  possibleTasks,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
  possibleTasks: { slug: string; triggerSource: TaskTriggerSource; isInLatestDeployment: boolean }[];
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (newValues: string[]) => {
    clearSearchValue();
    const previousTasks = values("tasks");
    const wasEmpty = previousTasks.length === 0 || previousTasks.every((v) => v === "");
    const isEmpty = newValues.length === 0 || newValues.every((v) => v === "");
    // empty -> tasks: temporarily force rootOnly off so child runs of the selected
    // task are visible. tasks -> empty: drop rootOnly so the toggle reverts to the
    // user's saved session preference. Neither writes to the cookie (see loader).
    const transitioningToTasks = wasEmpty && !isEmpty;
    const transitioningToNoTasks = !wasEmpty && isEmpty;
    replace({
      tasks: newValues,
      cursor: undefined,
      direction: undefined,
      ...(transitioningToTasks ? { rootOnly: "false" } : {}),
      ...(transitioningToNoTasks ? { rootOnly: undefined } : {}),
    });
  };

  const filtered = useMemo(() => {
    return possibleTasks.filter((item) => {
      return item.slug.toLowerCase().includes(searchValue.toLowerCase());
    });
  }, [searchValue, possibleTasks]);

  return (
    <SelectProvider value={values("tasks")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(360px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox placeholder={"Filter by task..."} value={searchValue} />
        <SelectList>
          {filtered
            .filter((item) => item.isInLatestDeployment)
            .map((item) => (
              <SelectItem
                key={`${item.triggerSource}-${item.slug}`}
                value={item.slug}
                icon={
                  <TaskTriggerSourceIcon source={item.triggerSource} className="size-4 flex-none" />
                }
                className="text-text-bright"
              >
                <MiddleTruncate text={item.slug} />
              </SelectItem>
            ))}
          {filtered.some((item) => !item.isInLatestDeployment) && (
            <SelectGroup>
              <SelectGroupLabel>Archived</SelectGroupLabel>
              {filtered
                .filter((item) => !item.isInLatestDeployment)
                .map((item) => (
                  <SelectItem
                    key={`${item.triggerSource}-${item.slug}`}
                    value={item.slug}
                    icon={
                      <span className="opacity-50">
                        <TaskTriggerSourceIcon
                          source={item.triggerSource}
                          className="size-4 flex-none"
                        />
                      </span>
                    }
                    className="text-text-bright"
                  >
                    <MiddleTruncate text={item.slug} />
                  </SelectItem>
                ))}
            </SelectGroup>
          )}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

const tasksShortcut = { key: "t" };

function PermanentTasksFilter({ possibleTasks }: Pick<RunFiltersProps, "possibleTasks">) {
  const { values, del } = useSearchParams();
  const tasks = values("tasks");
  const hasTasks = tasks.length > 0 && !tasks.every((v) => v === "");
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: tasksShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <TasksDropdown
          trigger={
            <Ariakit.TooltipProvider timeout={200}>
              <Ariakit.TooltipAnchor
                render={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  <Ariakit.Select
                    ref={triggerRef as any}
                    render={<div className="group cursor-pointer focus-custom" />}
                  />
                }
              >
                {hasTasks ? (
                  <AppliedFilter
                    label="Task"
                    icon={filterIcon("tasks")}
                    value={appliedSummary(
                      tasks.map((v) => {
                        const task = possibleTasks.find((task) => task.slug === v);
                        return task ? task.slug : v;
                      })
                    )}
                    onRemove={() => del(["tasks", "cursor", "direction", "rootOnly"])}
                    variant="secondary/small"
                    className="pl-1"
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1.5 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                    {filterIcon("tasks")}
                    <span>Tasks</span>
                  </div>
                )}
              </Ariakit.TooltipAnchor>
              <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span>Filter by task</span>
                  <ShortcutKey
                    className="size-4 flex-none"
                    shortcut={tasksShortcut}
                    variant="small"
                  />
                </div>
              </Ariakit.Tooltip>
            </Ariakit.TooltipProvider>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          possibleTasks={possibleTasks}
        />
      )}
    </FilterMenuProvider>
  );
}

function BulkActionsDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
  bulkActions,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
  bulkActions: RunFiltersProps["bulkActions"];
}) {
  const { value, replace } = useSearchParams();

  const handleChange = (value: string) => {
    clearSearchValue();
    replace({ bulkId: value, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    return bulkActions.filter((item) => {
      return (
        item.type.toLowerCase().includes(searchValue.toLowerCase()) ||
        item.createdAt.toISOString().includes(searchValue)
      );
    });
  }, [searchValue, bulkActions]);

  return (
    <SelectProvider value={value("bulkId")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(320px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox placeholder={"Filter by bulk action..."} value={searchValue} />
        <SelectList>
          <SelectItem value={""}>None</SelectItem>
          {filtered.map((item) => (
            <SelectItem key={item.id} value={item.id} className="[&>div]:h-fit">
              <div className="flex flex-col gap-1 py-1">
                <Paragraph variant="small/bright" className="truncate">
                  {item.name}
                </Paragraph>
                <div className="flex gap-3">
                  <BulkActionTypeCombo
                    type={item.type}
                    iconClassName="size-4"
                    labelClassName="text-text-dimmed"
                  />
                  <DateTime date={item.createdAt} />
                </div>
              </div>
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedBulkActionsFilter({ bulkActions }: Pick<RunFiltersProps, "bulkActions">) {
  const { value, del } = useSearchParams();

  const bulkId = value("bulkId");

  if (!bulkId) {
    return null;
  }

  const action = bulkActions.find((action) => action.id === bulkId);

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <BulkActionsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Bulk action"
                icon={filterIcon("bulkId")}
                value={bulkId}
                onRemove={() => del(["bulkId", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          bulkActions={bulkActions}
        />
      )}
    </FilterMenuProvider>
  );
}

function TagsDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const environment = useEnvironment();
  const { values, value, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({
      tags: values.length > 0 ? values : undefined,
      cursor: undefined,
      direction: undefined,
    });
  };

  const { period, from, to } = timeFilters({
    period: value("period"),
    from: value("from"),
    to: value("to"),
  });

  const tagValues = values("tags").filter((v) => v !== "");
  const selected = tagValues.length > 0 ? tagValues : undefined;

  const fetcher = useFetcher<typeof tagsLoader>();

  useEffect(() => {
    const searchParams = new URLSearchParams();
    if (searchValue) {
      searchParams.set("name", searchValue);
    }
    if (period) {
      searchParams.set("period", period);
    }
    if (from) {
      searchParams.set("from", from.getTime().toString());
    }
    if (to) {
      searchParams.set("to", to.getTime().toString());
    }
    fetcher.load(`/resources/environments/${environment.id}/runs/tags?${searchParams}`);
  }, [environment.id, searchValue, period, from?.getTime(), to?.getTime()]);

  const filtered = useMemo(() => {
    let items: string[] = [];
    if (searchValue === "") {
      items = [...(selected ?? [])];
    }

    if (fetcher.data === undefined) {
      return matchSorter(items, searchValue);
    }

    items.push(...fetcher.data.tags);

    return matchSorter(Array.from(new Set(items)), searchValue);
  }, [searchValue, fetcher.data, selected]);

  return (
    <SelectProvider value={selected ?? []} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        {(filtered.length > 0 || fetcher.state === "loading" || searchValue.length > 0) && (
          <ComboBox
            value={searchValue}
            render={(props) => (
              <div className="flex items-center justify-stretch">
                <input {...props} placeholder={"Filter by tags..."} />
                {fetcher.state === "loading" && <Spinner color="muted" />}
              </div>
            )}
          />
        )}
        <SelectList>
          {filtered.length > 0
            ? filtered.map((tag, index) => (
                <SelectItem key={tag} value={tag}>
                  {tag}
                </SelectItem>
              ))
            : null}
          {filtered.length === 0 && fetcher.state !== "loading" && (
            <SelectItem disabled>No tags found</SelectItem>
          )}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedTagsFilter() {
  const { values, del } = useSearchParams();

  const tags = values("tags");

  if (tags.length === 0 || tags.every((v) => v === "")) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <TagsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Tags"
                icon={filterIcon("tags")}
                value={appliedSummary(values("tags"))}
                onRemove={() => del(["tags", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function QueuesDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({
      queues: values.length > 0 ? values : undefined,
      cursor: undefined,
      direction: undefined,
    });
  };

  const queueValues = values("queues").filter((v) => v !== "");
  const selected = queueValues.length > 0 ? queueValues : undefined;

  const fetcher = useFetcher<typeof queuesLoader>();

  useDebounceEffect(
    searchValue,
    (s) => {
      const searchParams = new URLSearchParams();
      searchParams.set("per_page", "25");
      if (searchValue) {
        searchParams.set("query", s);
      }
      fetcher.load(
        `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${
          environment.slug
        }/queues?${searchParams.toString()}`
      );
    },
    250
  );

  const filtered = useMemo(() => {
    let items: { name: string; type: "custom" | "task"; value: string }[] = [];

    for (const queueName of selected ?? []) {
      const queueItem = fetcher.data?.queues.find((q) => q.name === queueName);
      if (!queueItem) {
        if (queueName.startsWith("task/")) {
          items.push({
            name: queueName.replace("task/", ""),
            type: "task",
            value: queueName,
          });
        } else {
          items.push({
            name: queueName,
            type: "custom",
            value: queueName,
          });
        }
      }
    }

    if (fetcher.data === undefined) {
      return matchSorter(items, searchValue);
    }

    items.push(
      ...fetcher.data.queues.map((q) => ({
        name: q.name,
        type: q.type,
        value: q.type === "task" ? `task/${q.name}` : q.name,
      }))
    );

    return matchSorter(Array.from(new Set(items)), searchValue, {
      keys: ["name"],
    });
  }, [searchValue, fetcher.data]);

  return (
    <SelectProvider value={selected ?? []} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox
          value={searchValue}
          render={(props) => (
            <div className="flex items-center justify-stretch">
              <input {...props} placeholder={"Filter by queues..."} />
              {fetcher.state === "loading" && <Spinner color="muted" />}
            </div>
          )}
        />
        <SelectList>
          {filtered.length > 0
            ? filtered.map((queue) => (
                <SelectItem
                  key={queue.value}
                  value={queue.value}
                  icon={
                    queue.type === "task" ? (
                      <TaskIcon className="size-4 shrink-0 text-blue-500" />
                    ) : (
                      <RectangleStackIcon className="size-4 shrink-0 text-purple-500" />
                    )
                  }
                  className="text-text-bright"
                >
                  {queue.name}
                </SelectItem>
              ))
            : null}
          {filtered.length === 0 && fetcher.state !== "loading" && (
            <SelectItem disabled>No queues found</SelectItem>
          )}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedQueuesFilter() {
  const { values, del } = useSearchParams();

  const queues = values("queues");

  if (queues.length === 0 || queues.every((v) => v === "")) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <QueuesDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Queues"
                icon={filterIcon("queues")}
                value={appliedSummary(values("queues").map((v) => v.replace("task/", "")))}
                onRemove={() => del(["queues", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function MachinesDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ machines: values, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    if (searchValue === "") {
      return machines;
    }
    return matchSorter(machines, searchValue);
  }, [searchValue]);

  return (
    <SelectProvider value={values("machines")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <SelectList>
          {filtered.map((item, index) => (
            <SelectItem
              key={item}
              value={item}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
              className="text-text-bright"
            >
              <MachineLabelCombo preset={item} labelClassName="text-text-bright" />
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedMachinesFilter() {
  const { values, del } = useSearchParams();
  const machines = values("machines");

  if (machines.length === 0 || machines.every((v) => v === "")) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <MachinesDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Machines"
                icon={filterIcon("machines")}
                value={appliedSummary(
                  machines.map((v) => {
                    const parsed = MachinePresetName.safeParse(v);
                    if (!parsed.success) {
                      return v;
                    }
                    return formatMachinePresetName(parsed.data);
                  })
                )}
                onRemove={() => del(["machines", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

export function VersionsDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({
      versions: values.length > 0 ? values : undefined,
      cursor: undefined,
      direction: undefined,
    });
  };

  const versionValues = values("versions").filter((v) => v !== "");
  const selected = versionValues.length > 0 ? versionValues : undefined;

  const fetcher = useFetcher<typeof versionsLoader>();

  useDebounceEffect(
    searchValue,
    (s) => {
      const searchParams = new URLSearchParams();
      if (searchValue) {
        searchParams.set("query", s);
      }
      fetcher.load(
        `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${
          environment.slug
        }/versions?${searchParams.toString()}`
      );
    },
    250
  );

  const filtered = useMemo(() => {
    let items: { version: string; isCurrent: boolean }[] = [];

    for (const version of selected ?? []) {
      const versionItem = fetcher.data?.versions.find((v) => v.version === version);
      if (!versionItem) {
        items.push({
          version,
          isCurrent: false,
        });
      }
    }

    if (fetcher.data === undefined) {
      return matchSorter(items, searchValue);
    }

    items.push(...fetcher.data.versions);

    if (searchValue === "") {
      return items;
    }

    return matchSorter(Array.from(new Set(items)), searchValue, {
      keys: ["version"],
    });
  }, [searchValue, fetcher.data]);

  return (
    <SelectProvider value={selected ?? []} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox
          value={searchValue}
          render={(props) => (
            <div className="flex items-center justify-stretch">
              <input {...props} placeholder={"Filter by versions..."} />
              {fetcher.state === "loading" && <Spinner color="muted" />}
            </div>
          )}
        />
        <SelectList>
          {filtered.length > 0
            ? filtered.map((version) => (
                <SelectItem
                  key={version.version}
                  value={version.version}
                  icon={<IconRotateClockwise2 className="size-4 flex-none text-text-dimmed" />}
                  className="text-text-bright"
                >
                  <span className="flex items-center gap-2">
                    <span className="grow truncate">{version.version}</span>
                    {version.isCurrent ? <Badge variant="extra-small">Current</Badge> : null}
                  </span>
                </SelectItem>
              ))
            : null}
          {filtered.length === 0 && fetcher.state !== "loading" && (
            <SelectItem disabled>No versions found</SelectItem>
          )}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedVersionsFilter() {
  const { values, del } = useSearchParams();

  const versions = values("versions");

  if (versions.length === 0 || versions.every((v) => v === "")) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <VersionsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Versions"
                icon={filterIcon("versions")}
                value={appliedSummary(values("versions"))}
                onRemove={() => del(["versions", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

const rootOnlyShortcut = { key: "o" };

function RootOnlyToggle({ defaultValue }: { defaultValue: boolean }) {
  const { value, replace } = useSearchParams();
  const searchValue = value("rootOnly");
  const rootOnly = searchValue !== undefined ? searchValue === "true" : defaultValue;

  const batchId = value("batchId");
  const runId = value("runId");
  const scheduleId = value("scheduleId");

  const disabled = !!batchId || !!runId || !!scheduleId;

  return (
    <Ariakit.TooltipProvider timeout={200}>
      <Ariakit.TooltipAnchor render={<div />}>
        <Switch
          disabled={disabled}
          variant="secondary/small"
          label="Root only"
          checked={disabled ? false : rootOnly}
          shortcut={rootOnlyShortcut}
          onCheckedChange={(checked) => {
            replace({
              rootOnly: checked ? "true" : "false",
            });
          }}
        />
      </Ariakit.TooltipAnchor>
      <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
        <div className="flex items-center gap-2">
          <span>Toggle root only</span>
          <ShortcutKey className="size-4 flex-none" shortcut={rootOnlyShortcut} variant="small" />
        </div>
      </Ariakit.Tooltip>
    </Ariakit.TooltipProvider>
  );
}

function validateRunId(value: string): string | undefined {
  if (!value.startsWith("run_")) return "Run IDs start with 'run_'";
  if (value.length !== 25 && value.length !== 29) return "Run IDs are 25/30 characters long";
}

function RunIdDropdown(
  props: Omit<
    IdFilterDropdownProps,
    "label" | "placeholder" | "paramKey" | "validate" | "inputWidth"
  >
) {
  return (
    <IdFilterDropdown
      {...props}
      label="Run ID"
      placeholder="run_"
      paramKey="runId"
      validate={validateRunId}
      inputWidth="w-[27ch]"
    />
  );
}

function AppliedRunIdFilter() {
  const { value, del } = useSearchParams();

  if (value("runId") === undefined) {
    return null;
  }

  const runId = value("runId");

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <RunIdDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Run ID"
                icon={filterIcon("runId")}
                value={runId}
                onRemove={() => del(["runId", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function validateBatchId(value: string): string | undefined {
  if (!value.startsWith("batch_")) return "Batch IDs start with 'batch_'";
  if (value.length !== 27 && value.length !== 31) return "Batch IDs are 27 or 31 characters long";
}

function BatchIdDropdown(
  props: Omit<IdFilterDropdownProps, "label" | "placeholder" | "paramKey" | "validate">
) {
  return (
    <IdFilterDropdown
      {...props}
      label="Batch ID"
      placeholder="batch_"
      paramKey="batchId"
      validate={validateBatchId}
    />
  );
}

function AppliedBatchIdFilter() {
  const { value, del } = useSearchParams();

  if (value("batchId") === undefined) {
    return null;
  }

  const batchId = value("batchId");

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <BatchIdDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Batch ID"
                icon={filterIcon("batchId")}
                value={batchId}
                onRemove={() => del(["batchId", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function validateScheduleId(value: string): string | undefined {
  if (!value.startsWith("sched")) return "Schedule IDs start with 'sched_'";
  if (value.length !== 27) return "Schedule IDs are 27 characters long";
}

function ScheduleIdDropdown(
  props: Omit<IdFilterDropdownProps, "label" | "placeholder" | "paramKey" | "validate">
) {
  return (
    <IdFilterDropdown
      {...props}
      label="Schedule ID"
      placeholder="sched_"
      paramKey="scheduleId"
      validate={validateScheduleId}
    />
  );
}

function AppliedScheduleIdFilter() {
  const { value, del } = useSearchParams();

  if (value("scheduleId") === undefined) {
    return null;
  }

  const scheduleId = value("scheduleId");

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <ScheduleIdDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Schedule ID"
                icon={filterIcon("scheduleId")}
                value={scheduleId}
                onRemove={() => del(["scheduleId", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function validateErrorId(value: string): string | undefined {
  if (!value.startsWith("error_")) return "Error IDs start with 'error_'";
}

function ErrorIdDropdown(
  props: Omit<IdFilterDropdownProps, "label" | "placeholder" | "paramKey" | "validate">
) {
  return (
    <IdFilterDropdown
      {...props}
      label="Error ID"
      placeholder="error_"
      paramKey="errorId"
      validate={validateErrorId}
    />
  );
}

function AppliedErrorIdFilter() {
  const { value, del } = useSearchParams();

  if (value("errorId") === undefined) {
    return null;
  }

  const errorId = value("errorId");

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <ErrorIdDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Error ID"
                icon={filterIcon("errorId")}
                value={errorId}
                onRemove={() => del(["errorId", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}
