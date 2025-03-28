import * as Ariakit from "@ariakit/react";
import {
  ClockIcon,
  FingerPrintIcon,
  Squares2X2Icon,
  TagIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Form, useFetcher } from "@remix-run/react";
import type { BulkActionType, TaskRunStatus, TaskTriggerSource } from "@trigger.dev/database";
import { ListChecks, ListFilterIcon } from "lucide-react";
import { matchSorter } from "match-sorter";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { DateTime } from "~/components/primitives/DateTime";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ComboBox,
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
import { appliedSummary, FilterMenuProvider, TimeFilter } from "./SharedFilters";
import {
  allTaskRunStatuses,
  descriptionForTaskRunStatus,
  filterableTaskRunStatuses,
  runStatusTitle,
  TaskRunStatusCombo,
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
  bulkId: z.string().optional(),
  period: z.preprocess((value) => (value === "all" ? undefined : value), z.string().optional()),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  rootOnly: z.coerce.boolean().optional(),
  batchId: z.string().optional(),
  runId: z.string().optional(),
  scheduleId: z.string().optional(),
});

export type TaskRunListSearchFilters = z.infer<typeof TaskRunListSearchFilters>;

type RunFiltersProps = {
  possibleTasks: { slug: string; triggerSource: TaskTriggerSource }[];
  bulkActions: {
    id: string;
    type: BulkActionType;
    createdAt: Date;
  }[];
  rootOnlyDefault: boolean;
  hasFilters: boolean;
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
    searchParams.has("scheduleId");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1">
      <FilterMenu {...props} />
      <RootOnlyToggle defaultValue={props.rootOnlyDefault} />
      <TimeFilter />
      <AppliedFilters {...props} />
      {hasFilters && (
        <Form className="h-6">
          {searchParams.has("rootOnly") && (
            <input type="hidden" name="rootOnly" value={searchParams.get("rootOnly") as string} />
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
    icon: <StatusIcon className="size-4" />,
  },
  { name: "tasks", title: "Tasks", icon: <TaskIcon className="size-4" /> },
  { name: "tags", title: "Tags", icon: <TagIcon className="size-4" /> },
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
      variant={"tertiary/small"}
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

function AppliedFilters({ possibleTasks, bulkActions }: RunFiltersProps) {
  return (
    <>
      <AppliedStatusFilter />
      <AppliedTaskFilter possibleTasks={possibleTasks} />
      <AppliedTagsFilter />
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
    case "tasks":
      return <TasksDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
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
              key={`${item.triggerSource}-${item.slug}`}
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

function RootOnlyToggle({ defaultValue }: { defaultValue: boolean }) {
  const { value, values, replace } = useSearchParams();
  const searchValue = value("rootOnly");
  const rootOnly = searchValue !== undefined ? searchValue === "true" : defaultValue;

  const batchId = value("batchId");
  const runId = value("runId");
  const scheduleId = value("scheduleId");
  const tasks = values("tasks");

  const disabled = !!batchId || !!runId || !!scheduleId || tasks.length > 0;

  return (
    <Switch
      disabled={disabled}
      variant="tertiary/small"
      label="Root only"
      checked={disabled ? false : rootOnly}
      className="bg-tertiary transition hover:bg-charcoal-600"
      onCheckedChange={(checked) => {
        replace({
          rootOnly: checked ? "true" : "false",
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
    } else if (runId.length !== 25 && runId.length !== 29) {
      error = "Run IDs are 25/30 characters long";
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
                modifiers: ["mod"],
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
                modifiers: ["mod"],
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
            <Label>Schedule ID</Label>
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
                modifiers: ["mod"],
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
