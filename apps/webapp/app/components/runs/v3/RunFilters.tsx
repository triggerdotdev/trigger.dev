import * as Ariakit from "@ariakit/react";
import {
  ArrowPathIcon,
  CalendarIcon,
  CpuChipIcon,
  InboxStackIcon,
  TagIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { Form, useFetcher } from "@remix-run/react";
import type {
  RuntimeEnvironment,
  TaskTriggerSource,
  TaskRunStatus,
  BulkActionType,
} from "@trigger.dev/database";
import { ListFilterIcon } from "lucide-react";
import type { ReactNode } from "react";
import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { EnvironmentLabel, environmentTitle } from "~/components/environments/EnvironmentLabel";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";
import { Button } from "../../primitives/Buttons";
import {
  TaskRunStatusCombo,
  allTaskRunStatuses,
  filterableTaskRunStatuses,
  descriptionForTaskRunStatus,
  runStatusTitle,
} from "./TaskRunStatus";
import { TaskTriggerSourceIcon } from "./TaskTriggerSource";
import { DateTime } from "~/components/primitives/DateTime";
import { BulkActionStatusCombo } from "./BulkAction";
import { type loader } from "~/routes/resources.projects.$projectParam.runs.tags";
import { useProject } from "~/hooks/useProject";
import { Spinner } from "~/components/primitives/Spinner";
import { matchSorter } from "match-sorter";

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
    searchParams.has("tags");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1">
      <FilterMenu {...props} />
      <AppliedFilters {...props} />
      {hasFilters && (
        <Form>
          <Button variant="minimal/small" LeadingIcon={XMarkIcon}>
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
  { name: "bulk", title: "Bulk action", icon: <InboxStackIcon className="size-4" /> },
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
      return <CreatedDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "bulk":
      return <BulkActionsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "tags":
      return <TagsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
  }
}

function MainMenu({ searchValue, trigger, clearSearchValue, setFilterType }: MenuProps) {
  const filtered = useMemo(() => {
    return filterTypes.filter((item) =>
      item.title.toLowerCase().includes(searchValue.toLowerCase())
    );
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
              icon={<TaskTriggerSourceIcon source={item.triggerSource} className="size-4" />}
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

  const fetcher = useFetcher<typeof loader>();

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
    label: "All periods",
    value: "all",
  },
  {
    label: "5 mins ago",
    value: "5m",
  },
  {
    label: "15 mins ago",
    value: "15m",
  },
  {
    label: "30 mins ago",
    value: "30m",
  },
  {
    label: "1 hour ago",
    value: "1h",
  },
  {
    label: "3 hours ago",
    value: "3h",
  },
  {
    label: "6 hours ago",
    value: "6h",
  },
  {
    label: "1 day ago",
    value: "1d",
  },
  {
    label: "3 days ago",
    value: "3d",
  },
  {
    label: "7 days ago",
    value: "7d",
  },
  {
    label: "10 days ago",
    value: "10d",
  },
  {
    label: "14 days ago",
    value: "14d",
  },
  {
    label: "30 days ago",
    value: "30d",
  },
];

function CreatedDropdown({
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
  const { value, replace } = useSearchParams();

  const handleChange = (newValue: string) => {
    clearSearchValue();
    if (newValue === "all") {
      if (!value) return;
    }

    replace({ period: newValue, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    return timePeriods.filter((item) =>
      item.label.toLowerCase().includes(searchValue.toLowerCase())
    );
  }, [searchValue]);

  return (
    <SelectProvider value={value("period")} setValue={handleChange} virtualFocus={true}>
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
        <CreatedDropdown
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
        />
      )}
    </FilterMenuProvider>
  );
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
