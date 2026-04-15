import * as Ariakit from "@ariakit/react";
import { ClockIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useNavigate } from "@remix-run/react";
import { useCallback, useRef } from "react";
import { z } from "zod";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { SearchInput } from "~/components/primitives/SearchInput";
import {
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
} from "~/components/primitives/Select";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { Button } from "../../primitives/Buttons";
import { ScheduleTypeIcon, scheduleTypeName } from "./ScheduleType";
import { FilterMenuProvider } from "./SharedFilters";

export const ScheduleListFilters = z.object({
  page: z.coerce.number().default(1),
  tasks: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
  type: z.union([z.literal("declarative"), z.literal("imperative")]).optional(),
  search: z.string().optional(),
});

export type ScheduleListFilters = z.infer<typeof ScheduleListFilters>;

type ScheduleFiltersProps = {
  possibleTasks: string[];
};

export function ScheduleFilters({ possibleTasks }: ScheduleFiltersProps) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("tasks") || searchParams.has("search") || searchParams.has("type");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1.5">
      <ScheduleSearchInput />
      <PermanentTaskFilter possibleTasks={possibleTasks} />
      <PermanentTypeFilter />
      {hasFilters && <ClearFiltersButton />}
    </div>
  );
}

function ScheduleSearchInput() {
  return <SearchInput placeholder="Search schedules…" resetParams={["page"]} />;
}

const typeShortcut = { key: "y" };

function PermanentTypeFilter() {
  const navigate = useNavigate();
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const currentType = searchParams.get("type") ?? undefined;
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: typeShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  const handleChange = useCallback(
    (value: string | string[]) => {
      const selected = Array.isArray(value) ? value[0] : value;
      const params = new URLSearchParams(location.search);
      if (!selected || selected === "ALL") {
        params.delete("type");
      } else {
        params.set("type", selected);
      }
      params.delete("page");
      navigate(`${location.pathname}?${params.toString()}`);
    },
    [location, navigate]
  );

  const typeLabel = currentType
    ? scheduleTypeName(currentType.toUpperCase() as "IMPERATIVE" | "DECLARATIVE")
    : "All types";

  return (
    <FilterMenuProvider>
      {() => (
        <SelectProvider value={currentType ?? "ALL"} setValue={handleChange} virtualFocus={true}>
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
              <AppliedFilter
                label="Type"
                value={typeLabel}
                removable={!!currentType}
                onRemove={() => handleChange("ALL")}
                variant="secondary/small"
              />
            </Ariakit.TooltipAnchor>
            <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span>Filter by type</span>
                <ShortcutKey className="size-4 flex-none" shortcut={typeShortcut} variant="small" />
              </div>
            </Ariakit.Tooltip>
          </Ariakit.TooltipProvider>
          <SelectPopover className="min-w-0 max-w-[min(240px,var(--popover-available-width))]">
            <SelectList>
              <SelectItem value="ALL" className="text-text-bright">
                All types
              </SelectItem>
              <SelectItem value="declarative">
                <div className="flex items-center gap-1">
                  <ScheduleTypeIcon type="DECLARATIVE" className="text-text-dimmed" />
                  <span className="text-text-bright">{scheduleTypeName("DECLARATIVE")}</span>
                </div>
              </SelectItem>
              <SelectItem value="imperative">
                <div className="flex items-center gap-1">
                  <ScheduleTypeIcon type="IMPERATIVE" className="text-text-dimmed" />
                  <span className="text-text-bright">{scheduleTypeName("IMPERATIVE")}</span>
                </div>
              </SelectItem>
            </SelectList>
          </SelectPopover>
        </SelectProvider>
      )}
    </FilterMenuProvider>
  );
}

const taskShortcut = { key: "t" };

function PermanentTaskFilter({ possibleTasks }: { possibleTasks: string[] }) {
  const navigate = useNavigate();
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const currentTask = searchParams.get("tasks") ?? undefined;
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: taskShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  const handleChange = useCallback(
    (value: string | string[]) => {
      const selected = Array.isArray(value) ? value[0] : value;
      const params = new URLSearchParams(location.search);
      if (!selected || selected === "ALL") {
        params.delete("tasks");
      } else {
        params.set("tasks", selected);
      }
      params.delete("page");
      navigate(`${location.pathname}?${params.toString()}`);
    },
    [location, navigate]
  );

  const taskLabel = currentTask ?? "All tasks";

  return (
    <FilterMenuProvider>
      {() => (
        <SelectProvider value={currentTask ?? "ALL"} setValue={handleChange} virtualFocus={true}>
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
              <AppliedFilter
                label="Task"
                icon={<ClockIcon className="size-4" />}
                value={taskLabel}
                removable={!!currentTask}
                onRemove={() => handleChange("ALL")}
                variant="secondary/small"
              />
            </Ariakit.TooltipAnchor>
            <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span>Filter by task</span>
                <ShortcutKey className="size-4 flex-none" shortcut={taskShortcut} variant="small" />
              </div>
            </Ariakit.Tooltip>
          </Ariakit.TooltipProvider>
          <SelectPopover className="min-w-0 max-w-[min(360px,var(--popover-available-width))]">
            <SelectList>
              <SelectItem value="ALL" className="text-text-bright">
                All tasks
              </SelectItem>
              {possibleTasks.map((task) => (
                <SelectItem
                  key={task}
                  value={task}
                  icon={<ClockIcon className="size-4 text-schedules" />}
                  className="text-text-bright"
                >
                  {task}
                </SelectItem>
              ))}
            </SelectList>
          </SelectPopover>
        </SelectProvider>
      )}
    </FilterMenuProvider>
  );
}

function ClearFiltersButton() {
  const navigate = useNavigate();
  const location = useOptimisticLocation();

  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(location.search);
    params.delete("page");
    params.delete("tasks");
    params.delete("search");
    params.delete("type");
    navigate(`${location.pathname}?${params.toString()}`);
  }, [location, navigate]);

  return (
    <div className="h-6">
      <Button
        variant="minimal/small"
        onClick={clearFilters}
        LeadingIcon={XMarkIcon}
        tooltip="Clear all filters"
      />
    </div>
  );
}
