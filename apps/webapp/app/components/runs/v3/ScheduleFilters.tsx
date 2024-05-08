import { XMarkIcon } from "@heroicons/react/20/solid";
import { useNavigate } from "@remix-run/react";
import { RuntimeEnvironment } from "@trigger.dev/database";
import { useCallback } from "react";
import { z } from "zod";
import { Input } from "~/components/primitives/Input";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useThrottle } from "~/hooks/useThrottle";
import { EnvironmentLabel } from "../../environments/EnvironmentLabel";
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

export const ScheduleListFilters = z.object({
  page: z.coerce.number().default(1),
  tasks: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
  environments: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
  search: z.string().optional(),
});

export type ScheduleListFilters = z.infer<typeof ScheduleListFilters>;

const All = "ALL";

type DisplayableEnvironment = Pick<RuntimeEnvironment, "type" | "id"> & {
  userName?: string;
};

type ScheduleFiltersProps = {
  possibleEnvironments: DisplayableEnvironment[];
  possibleTasks: string[];
};

export function ScheduleFilters({ possibleEnvironments, possibleTasks }: ScheduleFiltersProps) {
  const navigate = useNavigate();
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const { environments, tasks, page, search } = ScheduleListFilters.parse(
    Object.fromEntries(searchParams.entries())
  );

  const hasFilters =
    searchParams.has("tasks") || searchParams.has("environments") || searchParams.has("search");

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

  const handleEnvironmentChange = useCallback((value: string | typeof All) => {
    handleFilterChange("environments", value === "ALL" ? undefined : value);
  }, []);

  const handleSearchChange = useThrottle((value: string) => {
    handleFilterChange("search", value.length === 0 ? undefined : value);
  }, 300);

  const clearFilters = useCallback(() => {
    searchParams.delete("page");
    searchParams.delete("enabled");
    searchParams.delete("tasks");
    searchParams.delete("environments");
    searchParams.delete("search");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  }, []);

  return (
    <div className="flex w-full flex-row">
      <Input
        name="search"
        placeholder="Search schedule id, external id, deduplication id or CRON pattern"
        icon="search"
        variant="tertiary"
        className="grow"
        defaultValue={search}
        onChange={(e) => handleSearchChange(e.target.value)}
      />
      <SelectGroup>
        <Select
          name="environment"
          value={environments?.at(0) ?? "ALL"}
          onValueChange={handleEnvironmentChange}
        >
          <SelectTrigger size="minimal" width="full">
            <SelectValue
              placeholder={"Select environment"}
              className="ml-2 whitespace-nowrap p-0"
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={"ALL"}>
              <Paragraph
                variant="extra-small"
                className="whitespace-nowrap pl-0.5 transition group-hover:text-text-bright"
              >
                All environments
              </Paragraph>
            </SelectItem>
            {possibleEnvironments.map((env) => (
              <SelectItem key={env.id} value={env.id}>
                <div className="flex items-center gap-x-2">
                  <EnvironmentLabel environment={env} userName={env.userName} />
                  <Paragraph variant="extra-small">environment</Paragraph>
                </div>
              </SelectItem>
            ))}
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
