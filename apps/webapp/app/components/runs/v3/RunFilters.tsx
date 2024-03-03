import { useNavigate } from "@remix-run/react";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { EnvironmentLabel } from "../../environments/EnvironmentLabel";
import { Paragraph } from "../../primitives/Paragraph";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../primitives/Select";
import { RuntimeEnvironment, TaskRunAttemptStatus } from "@trigger.dev/database";
import { useCallback } from "react";
import { z } from "zod";
import { Button } from "../../primitives/Buttons";
import { TimeFrameFilter } from "../TimeFrameFilter";
import { TaskRunStatus } from "./TaskRunStatus";

export const allTaskRunStatuses = [
  "ENQUEUED",
  "PENDING",
  "EXECUTING",
  "PAUSED",
  "FAILED",
  "COMPLETED",
  "CANCELED",
] as const;

export type ExtendedTaskAttemptStatus = (typeof allTaskRunStatuses)[number];

export const TaskAttemptStatus = z.enum(allTaskRunStatuses);

export const TaskRunListSearchFilters = z.object({
  cursor: z.string().optional(),
  direction: z.enum(["forward", "backward"]).optional(),
  environments: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
  tasks: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
  versions: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
  statuses: z.preprocess(
    (value) => (typeof value === "string" ? value.split(",") : undefined),
    TaskAttemptStatus.array().optional()
  ),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
});

export type TaskRunListSearchFilters = z.infer<typeof TaskRunListSearchFilters>;

const All = "ALL";

type DisplayableEnvironment = Pick<RuntimeEnvironment, "type" | "id"> & {
  userName?: string;
};

type RunFiltersProps = {
  possibleEnvironments: DisplayableEnvironment[];
  possibleTasks: string[];
};

export function RunsFilters({ possibleEnvironments, possibleTasks }: RunFiltersProps) {
  const navigate = useNavigate();
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const { environments, tasks, versions, statuses, from, to } = TaskRunListSearchFilters.parse(
    Object.fromEntries(searchParams.entries())
  );

  const handleFilterChange = useCallback((filterType: string, value: string | undefined) => {
    if (value) {
      searchParams.set(filterType, value);
    } else {
      searchParams.delete(filterType);
    }
    searchParams.delete("cursor");
    searchParams.delete("direction");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  }, []);

  const handleStatusChange = useCallback((value: TaskRunAttemptStatus | typeof All) => {
    handleFilterChange("statuses", value === "ALL" ? undefined : value);
  }, []);

  const handleTaskChange = useCallback((value: string | typeof All) => {
    handleFilterChange("tasks", value === "ALL" ? undefined : value);
  }, []);

  const handleEnvironmentChange = useCallback((value: string | typeof All) => {
    handleFilterChange("environments", value === "ALL" ? undefined : value);
  }, []);

  const handleTimeFrameChange = useCallback((range: { from?: number; to?: number }) => {
    if (range.from) {
      searchParams.set("from", range.from.toString());
    } else {
      searchParams.delete("from");
    }

    if (range.to) {
      searchParams.set("to", range.to.toString());
    } else {
      searchParams.delete("to");
    }

    searchParams.delete("cursor");
    searchParams.delete("direction");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  }, []);

  const clearFilters = useCallback(() => {
    searchParams.delete("statuses");
    searchParams.delete("environments");
    searchParams.delete("tasks");
    searchParams.delete("from");
    searchParams.delete("to");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  }, []);

  return (
    <div className="flex flex-row justify-between gap-x-2">
      <SelectGroup>
        <Select
          name="environment"
          value={environments?.at(0) ?? "ALL"}
          onValueChange={handleEnvironmentChange}
        >
          <SelectTrigger size="secondary/small" width="full">
            <SelectValue placeholder={"Select environment"} className="ml-2 p-0" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={"ALL"}>
              <Paragraph variant="extra-small" className="pl-0.5">
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
        <Select name="status" value={statuses?.at(0) ?? "ALL"} onValueChange={handleStatusChange}>
          <SelectTrigger size="secondary/small" width="full">
            <SelectValue placeholder="Select status" className="ml-2 p-0" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={"ALL"}>
              <Paragraph variant="extra-small" className="pl-0.5">
                All statuses
              </Paragraph>
            </SelectItem>
            {allTaskRunStatuses.map((status) => (
              <SelectItem key={status} value={status} className="text-xs">
                <TaskRunStatus status={status} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SelectGroup>

      <SelectGroup>
        <Select name="tasks" value={tasks?.at(0) ?? "ALL"} onValueChange={handleTaskChange}>
          <SelectTrigger size="secondary/small" width="full">
            <SelectValue placeholder="Select task" className="ml-2 p-0" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={"ALL"}>
              <Paragraph variant="extra-small" className="pl-0.5">
                All tasks
              </Paragraph>
            </SelectItem>
            {possibleTasks.map((task) => (
              <SelectItem key={task} value={task}>
                <Paragraph variant="extra-small" className="pl-0.5">
                  {task}
                </Paragraph>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SelectGroup>

      <TimeFrameFilter from={from} to={to} onRangeChanged={handleTimeFrameChange} />

      <Button variant="minimal/small" onClick={() => clearFilters()} LeadingIcon={"close"}>
        Clear
      </Button>
    </div>
  );
}
