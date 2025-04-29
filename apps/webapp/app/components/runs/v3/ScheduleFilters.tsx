import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useNavigate } from "@remix-run/react";
import { type RuntimeEnvironment } from "@trigger.dev/database";
import { useCallback } from "react";
import { z } from "zod";
import { Input } from "~/components/primitives/Input";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useThrottle } from "~/hooks/useThrottle";
import { Button } from "../../primitives/Buttons";
import { Paragraph } from "../../primitives/Paragraph";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../primitives/SimpleSelect";
import { ScheduleTypeCombo } from "./ScheduleType";

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

const All = "ALL";

type ScheduleFiltersProps = {
  possibleTasks: string[];
};

export function ScheduleFilters({ possibleTasks }: ScheduleFiltersProps) {
  const navigate = useNavigate();
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const { tasks, page, search, type } = ScheduleListFilters.parse(
    Object.fromEntries(searchParams.entries())
  );

  const hasFilters = searchParams.has("tasks") || searchParams.has("search");

  const handleFilterChange = useCallback((filterType: string, value: string | undefined) => {
    if (value) {
      searchParams.set(filterType, value);
    } else {
      searchParams.delete(filterType);
    }
    searchParams.delete("page");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  }, []);

  const handleTaskChange = useCallback((value: string | typeof All) => {
    handleFilterChange("tasks", value === "ALL" ? undefined : value);
  }, []);

  const handleTypeChange = useCallback((value: string | typeof All) => {
    handleFilterChange("type", value === "ALL" ? undefined : value);
  }, []);

  const handleSearchChange = useThrottle((value: string) => {
    handleFilterChange("search", value.length === 0 ? undefined : value);
  }, 300);

  const clearFilters = useCallback(() => {
    searchParams.delete("page");
    searchParams.delete("enabled");
    searchParams.delete("tasks");
    searchParams.delete("search");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  }, []);

  return (
    <div className="flex w-full">
      <Input
        name="search"
        placeholder="Search schedule id, external id, deduplication id or CRON pattern"
        icon={MagnifyingGlassIcon}
        variant="tertiary"
        className="grow"
        defaultValue={search}
        onChange={(e) => handleSearchChange(e.target.value)}
      />
      <SelectGroup className="ml-2">
        <Select name="type" value={type ?? "ALL"} onValueChange={handleTypeChange}>
          <SelectTrigger size="minimal" width="full">
            <SelectValue placeholder={"Select type"} className="ml-2 whitespace-nowrap p-0" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={"ALL"}>
              <Paragraph
                variant="extra-small"
                className="whitespace-nowrap pl-0.5 transition group-hover:text-text-bright"
              >
                All types
              </Paragraph>
            </SelectItem>
            <SelectItem value={"declarative"}>
              <ScheduleTypeCombo type="DECLARATIVE" className="text-xs text-text-dimmed" />
            </SelectItem>
            <SelectItem value={"imperative"}>
              <ScheduleTypeCombo type="IMPERATIVE" className="text-xs text-text-dimmed" />
            </SelectItem>
          </SelectContent>
        </Select>
      </SelectGroup>

      <SelectGroup>
        <Select name="tasks" value={tasks?.at(0) ?? "ALL"} onValueChange={handleTaskChange}>
          <SelectTrigger size="minimal" width="full">
            <SelectValue placeholder="Select task" className="ml-2 p-0" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={"ALL"}>
              <Paragraph
                variant="extra-small"
                className="whitespace-nowrap pl-0.5 transition group-hover:text-text-bright"
              >
                All tasks
              </Paragraph>
            </SelectItem>
            {possibleTasks.map((task) => (
              <SelectItem key={task} value={task}>
                <Paragraph
                  variant="extra-small"
                  className="whitespace-nowrap pl-0.5 transition group-hover:text-text-bright"
                >
                  {task}
                </Paragraph>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SelectGroup>

      {hasFilters && (
        <Button variant="minimal/small" onClick={() => clearFilters()} LeadingIcon={XMarkIcon}>
          Clear all
        </Button>
      )}
    </div>
  );
}
