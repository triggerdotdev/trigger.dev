import * as Ariakit from "@ariakit/react";
import {
  CalendarIcon,
  ClockIcon,
  CpuChipIcon,
  FingerPrintIcon,
  Squares2X2Icon,
  TagIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { ListChecks } from "lucide-react";
import { Form, useFetcher } from "@remix-run/react";
import type {
  BulkActionType,
  RuntimeEnvironment,
  TaskRunStatus,
  TaskTriggerSource,
} from "@trigger.dev/database";
import { ListFilterIcon } from "lucide-react";
import { matchSorter } from "match-sorter";
import type { ReactNode } from "react";
import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { EnvironmentLabel, environmentTitle } from "~/components/environments/EnvironmentLabel";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { DateField } from "~/components/primitives/DateField";
import { DateTime } from "~/components/primitives/DateTime";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ComboBox,
  ComboboxProvider,
  SelectButtonItem,
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
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { type loader as tagsLoader } from "~/routes/resources.projects.$projectParam.runs.tags";
import { Button } from "../../primitives/Buttons";
import { BulkActionStatusCombo } from "./BulkAction";
import {
  TaskRunStatusCombo,
  allTaskRunStatuses,
  descriptionForTaskRunStatus,
  filterableTaskRunStatuses,
  runStatusTitle,
} from "./TaskRunStatus";
import { TaskTriggerSourceIcon } from "./TaskTriggerSource";

export const TaskAttemptStatus = z.enum(allTaskRunStatuses);

export const TaskRunListSearchFilters = z.object({
  cursor: z.string().optional(),
  direction: z.enum(["forward", "backward"]).optional(),
  environments: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    z.string().array().optional()
  ),
  tasks: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    z.string().array().optional()
  ),
  versions: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    z.string().array().optional()
  ),
  statuses: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    TaskAttemptStatus.array().optional()
  ),
  tags: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    z.string().array().optional()
  ),
  period: z.preprocess((value) => (value === "all" ? undefined : value), z.string().optional()),
  bulkId: z.string().optional(),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  showChildTasks: z.coerce.boolean().optional(),
  batchId: z.string().optional(),
  runId: z.string().optional(),
  scheduleId: z.string().optional(),
});

export type TaskRunListSearchFilters = z.infer<typeof TaskRunListSearchFilters>;

type DisplayableEnvironment = Pick<RuntimeEnvironment, "type" | "id"> & {
  userName?: string;
};

type RunFiltersProps = {
  possibleEnvironments: DisplayableEnvironment[];
  possibleTasks: { slug: string; triggerSource: TaskTriggerSource }[];
  bulkActions: {
    id: string;
    type: BulkActionType;
    createdAt: Date;
  }[];
  hasFilters: boolean;
};

export function RunsFilters(props: RunFiltersProps) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("statuses") ||
    searchParams.has("environments") ||
    searchParams.has("tasks") ||
    searchParams.has("period") ||
    searchParams.has("bulkId") ||
    searchParams.has("tags") ||
    searchParams.has("from") ||
    searchParams.has("to");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1">
      <FilterMenu {...props} />
      <ShowChildTasksToggle />
      <AppliedFilters {...props} />
      {hasFilters && (
        <Form className="h-6">
          {searchParams.has("showChildTasks") && (
            <input
              type="hidden"
              name="showChildTasks"
              value={searchParams.get("showChildTasks") as string}
            />
          )}
          <Button variant="minimal/small" LeadingIcon={TrashIcon}>
            Clear all
          </Button>
        </Form>
      )}
    </div>
  );
}

const filterTypes = [
  {
    name: "statuses",
    title: "Status",
    icon: (
      <div className="flex size-4 items-center justify-center">
        <div className="size-3 rounded-full border-2 border-text-dimmed" />
      </div>
    ),
  },
  { name: "environments", title: "Environment", icon: <CpuChipIcon className="size-4" /> },
  { name: "tasks", title: "Tasks", icon: <TaskIcon className="size-4" /> },
  { name: "tags", title: "Tags", icon: <TagIcon className="size-4" /> },
  { name: "created", title: "Created", icon: <CalendarIcon className="size-4" /> },
  { name: "daterange", title: "Custom date range", icon: <CalendarIcon className="size-4" /> },
  { name: "run", title: "Run ID", icon: <FingerPrintIcon className="size-4" /> },
  { name: "batch", title: "Batch ID", icon: <Squares2X2Icon className="size-4" /> },
  { name: "schedule", title: "Schedule ID", icon: <ClockIcon className="size-4" /> },
  { name: "bulk", title: "Bulk action", icon: <ListChecks className="size-4" /> },
] as const;

type FilterType = (typeof filterTypes)[number]["name"];

const shortcut = { key: "f" };

function FilterMenu(props: RunFiltersProps) {
  const [filterType, setFilterType] = useState<FilterType | undefined>();

  const filterTrigger = (
    <SelectTrigger
      icon={
        <div className="flex size-4 items-center justify-center">
          <ListFilterIcon className="size-3.5" />
        </div>
      }
      variant={"minimal/small"}
      shortcut={shortcut}
      tooltipTitle={"Filter runs"}
    >
      Filter
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

function FilterMenuProvider({
  children,
  onClose,
}: {
  children: (search: string, setSearch: (value: string) => void) => React.ReactNode;
  onClose?: () => void;
}) {
  const [searchValue, setSearchValue] = useState("");

  return (
    <ComboboxProvider
      resetValueOnHide
      setValue={(value) => {
        startTransition(() => {
          setSearchValue(value);
        });
      }}
      setOpen={(open) => {
        if (!open && onClose) {
          onClose();
        }
      }}
    >
      {children(searchValue, setSearchValue)}
    </ComboboxProvider>
  );
}

function AppliedFilters({ possibleEnvironments, possibleTasks, bulkActions }: RunFiltersProps) {
  return (
    <>
      <AppliedStatusFilter />
      <AppliedEnvironmentFilter possibleEnvironments={possibleEnvironments} />
      <AppliedTaskFilter possibleTasks={possibleTasks} />
      <AppliedTagsFilter />
      <AppliedPeriodFilter />
      <AppliedCustomDateRangeFilter />
      <AppliedRunIdFilter />
      <AppliedBatchIdFilter />
      <AppliedScheduleIdFilter />
      <AppliedBulkActionsFilter bulkActions={bulkActions} />
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
    case "statuses":
      return <StatusDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "environments":
      return <EnvironmentsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "tasks":
      return <TasksDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "created":
      return <CreatedAtDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "daterange":
      return <CustomDateRangeDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "bulk":
      return <BulkActionsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "tags":
      return <TagsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "run":
      return <RunIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "batch":
      return <BatchIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "schedule":
      return <ScheduleIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
  }
}

function MainMenu({ searchValue, trigger, clearSearchValue, setFilterType }: MenuProps) {
  const filtered = useMemo(() => {
    return filterTypes.filter((item) => {
      if (item.name === "daterange") return false;
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
              {type.title}
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
                  <TooltipContent side="right" sideOffset={9}>
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

function AppliedStatusFilter() {
  const { values, del } = useSearchParams();
  const statuses = values("statuses");

  if (statuses.length === 0) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <StatusDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Status"
                value={appliedSummary(statuses.map((v) => runStatusTitle(v as TaskRunStatus)))}
                onRemove={() => del(["statuses", "cursor", "direction"])}
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

function EnvironmentsDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
  possibleEnvironments,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
  possibleEnvironments: DisplayableEnvironment[];
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ environments: values, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    return possibleEnvironments.filter((item) => {
      const title = environmentTitle(item, item.userName);
      return title.toLowerCase().includes(searchValue.toLowerCase());
    });
  }, [searchValue, possibleEnvironments]);

  return (
    <SelectProvider value={values("environments")} setValue={handleChange} virtualFocus={true}>
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
        <ComboBox placeholder={"Filter by environment..."} value={searchValue} />
        <SelectList>
          {filtered.map((item, index) => (
            <SelectItem
              key={item.id}
              value={item.id}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <EnvironmentLabel environment={item} userName={item.userName} />
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedEnvironmentFilter({
  possibleEnvironments,
}: Pick<RunFiltersProps, "possibleEnvironments">) {
  const { values, del } = useSearchParams();

  if (values("environments").length === 0) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <EnvironmentsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Environment"
                value={appliedSummary(
                  values("environments").map((v) => {
                    const environment = possibleEnvironments.find((env) => env.id === v);
                    return environment ? environmentTitle(environment, environment.userName) : v;
                  })
                )}
                onRemove={() => del(["environments", "cursor", "direction"])}
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          possibleEnvironments={possibleEnvironments}
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
  possibleTasks: { slug: string; triggerSource: TaskTriggerSource }[];
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ tasks: values, cursor: undefined, direction: undefined });
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
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
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
          {filtered.map((item, index) => (
            <SelectItem
              key={item.slug}
              value={item.slug}
              icon={
                <TaskTriggerSourceIcon source={item.triggerSource} className="size-4 flex-none" />
              }
            >
              {item.slug}
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedTaskFilter({ possibleTasks }: Pick<RunFiltersProps, "possibleTasks">) {
  const { values, del } = useSearchParams();

  if (values("tasks").length === 0) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <TasksDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Task"
                value={appliedSummary(
                  values("tasks").map((v) => {
                    const task = possibleTasks.find((task) => task.slug === v);
                    return task ? task.slug : v;
                  })
                )}
                onRemove={() => del(["tasks", "cursor", "direction"])}
              />
            </Ariakit.Select>
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
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
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
          {filtered.map((item, index) => (
            <SelectItem key={item.id} value={item.id}>
              <div className="flex gap-3">
                <BulkActionStatusCombo type={item.type} iconClassName="size-4" />
                <DateTime date={item.createdAt} />
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
                value={bulkId}
                onRemove={() => del(["bulkId", "cursor", "direction"])}
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
  const project = useProject();
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({
      tags: values,
      cursor: undefined,
      direction: undefined,
    });
  };

  const fetcher = useFetcher<typeof tagsLoader>();

  useEffect(() => {
    const searchParams = new URLSearchParams();
    if (searchValue) {
      searchParams.set("name", encodeURIComponent(searchValue));
    }
    fetcher.load(`/resources/projects/${project.slug}/runs/tags?${searchParams}`);
  }, [searchValue]);

  const filtered = useMemo(() => {
    let items: string[] = [];
    if (searchValue === "") {
      items = values("tags");
    }

    if (fetcher.data === undefined) {
      return matchSorter(items, searchValue);
    }

    items.push(...fetcher.data.tags.map((t) => t.name));

    return matchSorter(Array.from(new Set(items)), searchValue);
  }, [searchValue, fetcher.data]);

  return (
    <SelectProvider value={values("tags")} setValue={handleChange} virtualFocus={true}>
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
              <input {...props} placeholder={"Filter by tags..."} />
              {fetcher.state === "loading" && <Spinner color="muted" />}
            </div>
          )}
        />
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

  if (tags.length === 0) {
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
                value={appliedSummary(values("tags"))}
                onRemove={() => del(["tags", "cursor", "direction"])}
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

const timePeriods = [
  {
    label: "Last 5 mins",
    value: "5m",
  },
  {
    label: "Last 30 mins",
    value: "30m",
  },
  {
    label: "Last 1 hour",
    value: "1h",
  },
  {
    label: "Last 6 hours",
    value: "6h",
  },
  {
    label: "Last 1 day",
    value: "1d",
  },
  {
    label: "Last 3 days",
    value: "3d",
  },
  {
    label: "Last 7 days",
    value: "7d",
  },
  {
    label: "Last 14 days",
    value: "14d",
  },
  {
    label: "Last 30 days",
    value: "30d",
  },
  {
    label: "All periods",
    value: "all",
  },
];

function CreatedAtDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
  setFilterType,
  hideCustomRange,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
  setFilterType?: (type: FilterType | undefined) => void;
  hideCustomRange?: boolean;
}) {
  const { value, replace } = useSearchParams();

  const from = value("from");
  const to = value("to");
  const period = value("period");

  const handleChange = (newValue: string) => {
    clearSearchValue();
    if (newValue === "all") {
      if (!period && !from && !to) return;

      replace({
        period: undefined,
        from: undefined,
        to: undefined,
        cursor: undefined,
        direction: undefined,
      });
      return;
    }

    if (newValue === "custom") {
      setFilterType?.("daterange");
      return;
    }

    replace({
      period: newValue,
      from: undefined,
      to: undefined,
      cursor: undefined,
      direction: undefined,
    });
  };

  const filtered = useMemo(() => {
    return timePeriods.filter((item) =>
      item.label.toLowerCase().includes(searchValue.toLowerCase())
    );
  }, [searchValue]);

  return (
    <SelectProvider
      value={from || to ? "custom" : period ?? "all"}
      setValue={handleChange}
      virtualFocus={true}
    >
      {trigger}
      <SelectPopover
        hideOnEnter={false}
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox placeholder={"Filter by period..."} value={searchValue} />
        <SelectList>
          {filtered.map((item) => (
            <SelectItem key={item.value} value={item.value} hideOnClick={false}>
              {item.label}
            </SelectItem>
          ))}
          {!hideCustomRange ? (
            <SelectItem value="custom" hideOnClick={false}>
              Custom date range
            </SelectItem>
          ) : null}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedPeriodFilter() {
  const { value, del } = useSearchParams();

  if (value("period") === undefined || value("period") === "all") {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <CreatedAtDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Created"
                value={
                  timePeriods.find((t) => t.value === value("period"))?.label ?? value("period")
                }
                onRemove={() => del(["period", "cursor", "direction"])}
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          hideCustomRange
        />
      )}
    </FilterMenuProvider>
  );
}

function CustomDateRangeDropdown({
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
  const [open, setOpen] = useState<boolean | undefined>();
  const { value, replace } = useSearchParams();
  const fromSearch = dateFromString(value("from"));
  const toSearch = dateFromString(value("to"));
  const [from, setFrom] = useState(fromSearch);
  const [to, setTo] = useState(toSearch);

  const apply = useCallback(() => {
    clearSearchValue();
    replace({
      period: undefined,
      cursor: undefined,
      direction: undefined,
      from: from?.getTime().toString(),
      to: to?.getTime().toString(),
    });

    setOpen(false);
  }, [from, to, replace]);

  return (
    <SelectProvider virtualFocus={true} open={open} setOpen={setOpen}>
      {trigger}
      <SelectPopover
        hideOnEnter={false}
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-1">
            <Label>From (local time)</Label>
            <DateField
              label="From time"
              defaultValue={from}
              onValueChange={setFrom}
              granularity="second"
              showNowButton
              showClearButton
              variant="small"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>To (local time)</Label>
            <DateField
              label="To time"
              defaultValue={to}
              onValueChange={setTo}
              granularity="second"
              showNowButton
              showClearButton
              variant="small"
            />
          </div>
          <div className="flex justify-between gap-1 border-t border-grid-dimmed pt-3">
            <Button variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary/small"
              shortcut={{
                modifiers: ["meta"],
                key: "Enter",
                enabledOnInputElements: true,
              }}
              onClick={() => apply()}
            >
              Apply
            </Button>
          </div>
        </div>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedCustomDateRangeFilter() {
  const { value, del } = useSearchParams();

  if (value("from") === undefined && value("to") === undefined) {
    return null;
  }

  const fromDate = dateFromString(value("from"));
  const toDate = dateFromString(value("to"));

  const rangeType = fromDate && toDate ? "range" : fromDate ? "from" : "to";

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <CustomDateRangeDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label={
                  rangeType === "range"
                    ? "Created"
                    : rangeType === "from"
                    ? "Created after"
                    : "Created before"
                }
                value={
                  <>
                    {rangeType === "range" ? (
                      <span>
                        <DateTime date={fromDate!} includeTime includeSeconds /> –{" "}
                        <DateTime date={toDate!} includeTime includeSeconds />
                      </span>
                    ) : rangeType === "from" ? (
                      <DateTime date={fromDate!} includeTime includeSeconds />
                    ) : (
                      <DateTime date={toDate!} includeTime includeSeconds />
                    )}
                  </>
                }
                onRemove={() => del(["period", "from", "to", "cursor", "direction"])}
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

function ShowChildTasksToggle() {
  const { value, replace } = useSearchParams();

  const showChildTasks = value("showChildTasks") === "true";

  const batchId = value("batchId");
  const runId = value("runId");
  const scheduleId = value("scheduleId");

  const disabled = !!batchId || !!runId || !!scheduleId;

  return (
    <Switch
      disabled={disabled}
      variant="small"
      label="Show child runs"
      checked={disabled ? true : showChildTasks}
      onCheckedChange={(checked) => {
        replace({
          showChildTasks: checked ? "true" : undefined,
        });
      }}
    />
  );
}

function RunIdDropdown({
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
  const [open, setOpen] = useState<boolean | undefined>();
  const { value, replace } = useSearchParams();
  const runIdValue = value("runId");

  const [runId, setRunId] = useState(runIdValue);

  const apply = useCallback(() => {
    clearSearchValue();
    replace({
      cursor: undefined,
      direction: undefined,
      runId: runId === "" ? undefined : runId?.toString(),
    });

    setOpen(false);
  }, [runId, replace]);

  let error: string | undefined = undefined;
  if (runId) {
    if (!runId.startsWith("run_")) {
      error = "Run IDs start with 'run_'";
    } else if (runId.length !== 25) {
      error = "Run IDs are 25 characters long";
    }
  }

  return (
    <SelectProvider virtualFocus={true} open={open} setOpen={setOpen}>
      {trigger}
      <SelectPopover
        hideOnEnter={false}
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
        className="max-w-[min(32ch,var(--popover-available-width))]"
      >
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-1">
            <Label>Run ID</Label>
            <Input
              placeholder="run_"
              value={runId ?? ""}
              onChange={(e) => setRunId(e.target.value)}
              variant="small"
              className="w-[27ch] font-mono"
              spellCheck={false}
            />
            {error ? <FormError>{error}</FormError> : null}
          </div>
          <div className="flex justify-between gap-1 border-t border-grid-dimmed pt-3">
            <Button variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={error !== undefined || !runId}
              variant="secondary/small"
              shortcut={{
                modifiers: ["meta"],
                key: "Enter",
                enabledOnInputElements: true,
              }}
              onClick={() => apply()}
            >
              Apply
            </Button>
          </div>
        </div>
      </SelectPopover>
    </SelectProvider>
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
                value={runId}
                onRemove={() => del(["runId", "cursor", "direction"])}
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

function BatchIdDropdown({
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
  const [open, setOpen] = useState<boolean | undefined>();
  const { value, replace } = useSearchParams();
  const batchIdValue = value("batchId");

  const [batchId, setBatchId] = useState(batchIdValue);

  const apply = useCallback(() => {
    clearSearchValue();
    replace({
      cursor: undefined,
      direction: undefined,
      batchId: batchId === "" ? undefined : batchId?.toString(),
    });

    setOpen(false);
  }, [batchId, replace]);

  let error: string | undefined = undefined;
  if (batchId) {
    if (!batchId.startsWith("batch_")) {
      error = "Batch IDs start with 'batch_'";
    } else if (batchId.length !== 27) {
      error = "Batch IDs are 27 characters long";
    }
  }

  return (
    <SelectProvider virtualFocus={true} open={open} setOpen={setOpen}>
      {trigger}
      <SelectPopover
        hideOnEnter={false}
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
        className="max-w-[min(32ch,var(--popover-available-width))]"
      >
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-1">
            <Label>Batch ID</Label>
            <Input
              placeholder="batch_"
              value={batchId ?? ""}
              onChange={(e) => setBatchId(e.target.value)}
              variant="small"
              className="w-[29ch] font-mono"
              spellCheck={false}
            />
            {error ? <FormError>{error}</FormError> : null}
          </div>
          <div className="flex justify-between gap-1 border-t border-grid-dimmed pt-3">
            <Button variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={error !== undefined || !batchId}
              variant="secondary/small"
              shortcut={{
                modifiers: ["meta"],
                key: "Enter",
                enabledOnInputElements: true,
              }}
              onClick={() => apply()}
            >
              Apply
            </Button>
          </div>
        </div>
      </SelectPopover>
    </SelectProvider>
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
                value={batchId}
                onRemove={() => del(["batchId", "cursor", "direction"])}
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

function ScheduleIdDropdown({
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
  const [open, setOpen] = useState<boolean | undefined>();
  const { value, replace } = useSearchParams();
  const scheduleIdValue = value("scheduleId");

  const [scheduleId, setScheduleId] = useState(scheduleIdValue);

  const apply = useCallback(() => {
    clearSearchValue();
    replace({
      cursor: undefined,
      direction: undefined,
      scheduleId: scheduleId === "" ? undefined : scheduleId?.toString(),
    });

    setOpen(false);
  }, [scheduleId, replace]);

  let error: string | undefined = undefined;
  if (scheduleId) {
    if (!scheduleId.startsWith("sched")) {
      error = "Schedule IDs start with 'sched_'";
    } else if (scheduleId.length !== 27) {
      error = "Schedule IDs are 27 characters long";
    }
  }

  return (
    <SelectProvider virtualFocus={true} open={open} setOpen={setOpen}>
      {trigger}
      <SelectPopover
        hideOnEnter={false}
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
        className="max-w-[min(32ch,var(--popover-available-width))]"
      >
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-1">
            <Label>Batch ID</Label>
            <Input
              placeholder="sched_"
              value={scheduleId ?? ""}
              onChange={(e) => setScheduleId(e.target.value)}
              variant="small"
              className="w-[29ch] font-mono"
              spellCheck={false}
            />
            {error ? <FormError>{error}</FormError> : null}
          </div>
          <div className="flex justify-between gap-1 border-t border-grid-dimmed pt-3">
            <Button variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={error !== undefined || !scheduleId}
              variant="secondary/small"
              shortcut={{
                modifiers: ["meta"],
                key: "Enter",
                enabledOnInputElements: true,
              }}
              onClick={() => apply()}
            >
              Apply
            </Button>
          </div>
        </div>
      </SelectPopover>
    </SelectProvider>
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
                value={scheduleId}
                onRemove={() => del(["scheduleId", "cursor", "direction"])}
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

function dateFromString(value: string | undefined | null): Date | undefined {
  if (!value) return;

  //is it an int?
  const int = parseInt(value);
  if (!isNaN(int)) {
    return new Date(int);
  }

  return new Date(value);
}

function appliedSummary(values: string[], maxValues = 3) {
  if (values.length === 0) {
    return null;
  }

  if (values.length > maxValues) {
    return `${values.slice(0, maxValues).join(", ")} + ${values.length - maxValues} more`;
  }

  return values.join(", ");
}
