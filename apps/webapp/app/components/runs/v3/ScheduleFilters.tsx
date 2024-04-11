import { TrashIcon } from "@heroicons/react/20/solid";
import { useNavigate } from "@remix-run/react";
import { RuntimeEnvironment } from "@trigger.dev/database";
import { useCallback } from "react";
import { z } from "zod";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
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
} from "../../primitives/Select";

export const ScheduleListFilters = z.object({
  page: z.number().default(1),
  tasks: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
  environments: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
  search: z.string().optional(),
  enabled: z.boolean().optional(),
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
  const { environments, tasks, page, search, enabled } = ScheduleListFilters.parse(
    Object.fromEntries(searchParams.entries())
  );

  const handleFilterChange = useCallback((filterType: string, value: string | undefined) => {
    if (value) {
      searchParams.set(filterType, value);
    } else {
      searchParams.delete(filterType);
    }
    searchParams.delete("page");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  }, []);

  const handleEnabledChange = useCallback((value: string | typeof All) => {
    handleFilterChange(
      "enabled",
      value === "ALL" ? undefined : value === "true" ? "true" : "false"
    );
  }, []);

  const handleTaskChange = useCallback((value: string | typeof All) => {
    handleFilterChange("tasks", value === "ALL" ? undefined : value);
  }, []);

  const handleEnvironmentChange = useCallback((value: string | typeof All) => {
    handleFilterChange("environments", value === "ALL" ? undefined : value);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    handleFilterChange("search", value.length === 0 ? undefined : value);
  }, []);

  const clearFilters = useCallback(() => {
    searchParams.delete("page");
    searchParams.delete("enabled");
    searchParams.delete("tasks");
    searchParams.delete("environments");
    searchParams.delete("search");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  }, []);

  return (
    <div className="flex flex-row justify-between">
      <SelectGroup>
        <Select
          name="environment"
          value={environments?.at(0) ?? "ALL"}
          onValueChange={handleEnvironmentChange}
        >
          <SelectTrigger size="minimal" width="full">
            <SelectValue placeholder={"Select environment"} className="ml-2 p-0" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={"ALL"}>
              <Paragraph
                variant="extra-small"
                className="pl-0.5 transition group-hover:text-text-bright"
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
                className="pl-0.5 transition group-hover:text-text-bright"
              >
                All tasks
              </Paragraph>
            </SelectItem>
            {possibleTasks.map((task) => (
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

      <SelectGroup>
        <Select
          name="status"
          value={enabled === undefined ? "ALL" : `${enabled}`}
          onValueChange={handleEnabledChange}
        >
          <SelectTrigger size="minimal" width="full">
            <SelectValue placeholder="Status" className="ml-2 p-0" />
          </SelectTrigger>
          <SelectContent className="overflow-visible">
            <SelectItem value={"ALL"} className="">
              <Paragraph
                variant="extra-small"
                className="pl-0.5 transition group-hover:text-text-bright"
              >
                All statuses
              </Paragraph>
            </SelectItem>
            <SelectItem value={"true"}>
              <Paragraph
                variant="extra-small"
                className="pl-0.5 transition group-hover:text-text-bright"
              >
                Enabled
              </Paragraph>
            </SelectItem>
            <SelectItem value={"false"}>
              <Paragraph
                variant="extra-small"
                className="pl-0.5 transition group-hover:text-text-bright"
              >
                Disabled
              </Paragraph>
            </SelectItem>
          </SelectContent>
        </Select>
      </SelectGroup>

      <Button variant="minimal/small" onClick={() => clearFilters()} LeadingIcon={TrashIcon} />
    </div>
  );
}
