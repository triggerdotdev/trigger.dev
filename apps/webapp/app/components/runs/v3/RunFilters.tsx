import { CpuChipIcon, PlusIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { RuntimeEnvironment, TaskRunStatus, TaskTriggerSource } from "@trigger.dev/database";
import { startTransition, useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { EnvironmentLabel, environmentTitle } from "~/components/environments/EnvironmentLabel";
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
import { useSearchParam } from "~/hooks/useSearchParam";
import { Button } from "../../primitives/Buttons";
import {
  TaskRunStatusCombo,
  allTaskRunStatuses,
  descriptionForTaskRunStatus,
  runStatusTitle,
} from "./TaskRunStatus";
import { TaskTriggerSourceIcon } from "./TaskTriggerSource";

export const TaskAttemptStatus = z.nativeEnum(TaskRunStatus);

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
};

export function RunsFilters(props: RunFiltersProps) {
  return (
    <div className="flex flex-row justify-between">
      <FilterMenu {...props} />
      {/* 
      <SelectGroup>
        <Select name="tasks" value={tasks?.at(0) ?? "ALL"} onValueChange={handleTaskChange}>
          <SelectTrigger size="minimal" width="full">
            <SelectValue placeholder="Select task" className="ml-2 p-0" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={"ALL"}>
              <Paragraph
                variant="extra-small"
                className="pl-0.5 transition group-hover:text-text-bright"
              >
                All tasks
              </Paragraph>
            </SelectItem>
            {possibleTasks
              .sort((a, b) => a.localeCompare(b)) // 🔤
              .map((task) => (
                <SelectItem key={task} value={task}>
                  <Paragraph
                    variant="extra-small"
                    className="pl-0.5 transition group-hover:text-text-bright"
                  >
                    {task}
                  </Paragraph>
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </SelectGroup>

      <TimeFrameFilter from={from} to={to} onRangeChanged={handleTimeFrameChange} /> */}
      <Form>
        <Button variant="minimal/small" LeadingIcon={XMarkIcon} />
      </Form>
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
];

type FilterType = (typeof filterTypes)[number]["name"];

const shortcut = { key: "f" };

function FilterMenu(props: RunFiltersProps) {
  const [filterType, setFilterType] = useState<FilterType | undefined>();

  const [searchValue, setSearchValue] = useState("");
  const clearSearchValue = useCallback(() => {
    setSearchValue("");
  }, [setSearchValue]);

  const filterTrigger = (
    <SelectTrigger
      icon={<PlusIcon className="h-4 w-4" />}
      variant={"tertiary/small"}
      shortcut={shortcut}
      tooltipTitle={"Filter runs"}
    >
      Filter
    </SelectTrigger>
  );

  return (
    <ComboboxProvider
      resetValueOnHide
      setValue={(value) => {
        startTransition(() => {
          setSearchValue(value);
        });
      }}
      setOpen={(open) => {
        if (!open) {
          setFilterType(undefined);
        }
      }}
    >
      <Menu
        searchValue={searchValue}
        clearSearchValue={clearSearchValue}
        trigger={filterTrigger}
        filterType={filterType}
        setFilterType={setFilterType}
        {...props}
      />
    </ComboboxProvider>
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
      return <Statuses {...props} />;
    case "environments":
      return <Environments {...props} />;
    case "tasks":
      return <Tasks {...props} />;
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
        <ComboBox placeholder={"Filter..."} shortcut={shortcut} value={searchValue} />
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

const statuses = allTaskRunStatuses.map((status) => ({
  title: runStatusTitle(status),
  value: status,
}));

function Statuses({ trigger, clearSearchValue, searchValue, setFilterType }: MenuProps) {
  const { values, replace } = useSearchParam("statuses");

  const handleChange = useCallback((values: string[]) => {
    clearSearchValue();
    replace(values);
  }, []);

  const filtered = useMemo(() => {
    return statuses.filter((item) => item.title.toLowerCase().includes(searchValue.toLowerCase()));
  }, [searchValue]);

  return (
    <SelectProvider value={values} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        hideOnEscape={() => {
          setFilterType(undefined);
          return false;
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

function Environments({
  trigger,
  clearSearchValue,
  searchValue,
  setFilterType,
  possibleEnvironments,
}: MenuProps) {
  const { values, replace } = useSearchParam("environments");

  const handleChange = useCallback((values: string[]) => {
    clearSearchValue();
    replace(values);
  }, []);

  const filtered = useMemo(() => {
    return possibleEnvironments.filter((item) => {
      const title = environmentTitle(item, item.userName);
      return title.toLowerCase().includes(searchValue.toLowerCase());
    });
  }, [searchValue, possibleEnvironments]);

  return (
    <SelectProvider value={values} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        hideOnEscape={() => {
          setFilterType(undefined);
          return false;
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

function Tasks({
  trigger,
  clearSearchValue,
  searchValue,
  setFilterType,
  possibleTasks,
}: MenuProps) {
  const { values, replace } = useSearchParam("tasks");

  const handleChange = useCallback((values: string[]) => {
    clearSearchValue();
    replace(values);
  }, []);

  const filtered = useMemo(() => {
    return possibleTasks.filter((item) => {
      return item.slug.toLowerCase().includes(searchValue.toLowerCase());
    });
  }, [searchValue, possibleTasks]);

  return (
    <SelectProvider value={values} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        hideOnEscape={() => {
          setFilterType(undefined);
          return false;
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
