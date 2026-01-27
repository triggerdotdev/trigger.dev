import type { TaskTriggerSource } from "@trigger.dev/database";
import type { ReactNode } from "react";
import { useMemo } from "react";
import * as Ariakit from "@ariakit/react";
import {
  ComboBox,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
} from "~/components/primitives/Select";
import { useSearchParams } from "~/hooks/useSearchParam";
import { TaskTriggerSourceIcon } from "~/components/runs/v3/TaskTriggerSource";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { appliedSummary, FilterMenuProvider } from "~/components/runs/v3/SharedFilters";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";

const shortcut = { key: "t" };

type TaskOption = {
  slug: string;
  triggerSource: TaskTriggerSource;
};

interface LogsTaskFilterProps {
  possibleTasks: TaskOption[];
}

export function LogsTaskFilter({ possibleTasks }: LogsTaskFilterProps) {
  const { values, replace, del } = useSearchParams();
  const selectedTasks = values("tasks");

  if (selectedTasks.length === 0 || selectedTasks.every((v) => v === "")) {
    return (
      <FilterMenuProvider>
        {(search, setSearch) => (
          <TasksDropdown
            trigger={
              <SelectTrigger
                icon={<TaskIcon className="size-4" />}
                variant="secondary/small"
                shortcut={shortcut}
                tooltipTitle="Filter by task"
              >
                Tasks
              </SelectTrigger>
            }
            searchValue={search}
            clearSearchValue={() => setSearch("")}
            possibleTasks={possibleTasks}
          />
        )}
      </FilterMenuProvider>
    );
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <TasksDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Task"
                icon={<TaskIcon className="size-4" />}
                value={appliedSummary(
                  selectedTasks.map((v) => {
                    const task = possibleTasks.find((task) => task.slug === v);
                    return task ? task.slug : v;
                  })
                )}
                onRemove={() => del(["tasks", "cursor", "direction"])}
                variant="secondary/small"
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
  possibleTasks: TaskOption[];
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
