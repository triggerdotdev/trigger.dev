import { TrashIcon } from "@heroicons/react/20/solid";
import { useNavigate } from "@remix-run/react";
import type { TaskRunStatus as TaskRunStatusType } from "@trigger.dev/database";
import { RuntimeEnvironment, TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";
import { useCallback } from "react";
import { z } from "zod";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
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
import { TimeFrameFilter } from "../TimeFrameFilter";
import { TaskRunStatusCombo, descriptionForTaskRunStatus } from "./TaskRunStatus";

export const allTaskRunStatuses = [
  "PENDING",
  "WAITING_FOR_DEPLOY",
  "EXECUTING",
  "RETRYING_AFTER_FAILURE",
  "WAITING_TO_RESUME",
  "COMPLETED_SUCCESSFULLY",
  "CANCELED",
  "COMPLETED_WITH_ERRORS",
  "INTERRUPTED",
  "SYSTEM_FAILURE",
  "CRASHED",
] as TaskRunStatusType[];

export const TaskAttemptStatus = z.nativeEnum(TaskRunStatus);

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
        <Select name="status" value={statuses?.at(0) ?? "ALL"} onValueChange={handleStatusChange}>
          <SelectTrigger size="minimal" width="full">
            <SelectValue placeholder="Select status" className="ml-2 p-0">
              {statuses?.at(0) ? (
                <TaskRunStatusCombo
                  status={statuses[0]}
                  className="text-xs"
                  iconClassName="animate-none"
                />
              ) : (
                "All statuses"
              )}
            </SelectValue>
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
            {allTaskRunStatuses.map((status) => (
              <TooltipProvider key={status}>
                <Tooltip>
                  <TooltipTrigger className="group flex w-full flex-col py-0">
                    <SelectItem value={status} className="">
                      <TaskRunStatusCombo
                        status={status}
                        className="text-xs"
                        iconClassName="animate-none"
                      />
                      <TooltipContent side="right" sideOffset={9}>
                        <Paragraph variant="extra-small">
                          {descriptionForTaskRunStatus(status)}
                        </Paragraph>
                      </TooltipContent>
                    </SelectItem>
                  </TooltipTrigger>
                </Tooltip>
              </TooltipProvider>
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

      <TimeFrameFilter from={from} to={to} onRangeChanged={handleTimeFrameChange} />

      <Button variant="minimal/small" onClick={() => clearFilters()} LeadingIcon={TrashIcon} />
    </div>
  );
}
