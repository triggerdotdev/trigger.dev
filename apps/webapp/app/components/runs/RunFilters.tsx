import {
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  NoSymbolIcon,
  PauseCircleIcon,
  TrashIcon,
  XCircleIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { useNavigate } from "@remix-run/react";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { cn } from "~/utils/cn";
import { EnvironmentLabel } from "../environments/EnvironmentLabel";
import { Paragraph } from "../primitives/Paragraph";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/SimpleSelect";
import { Spinner } from "../primitives/Spinner";
import {
  type FilterableEnvironment,
  type FilterableStatus,
  RunListSearchSchema,
  environmentKeys,
  statusKeys,
} from "./RunStatuses";
import { TimeFrameFilter } from "./TimeFrameFilter";
import { Button } from "../primitives/Buttons";
import { useCallback } from "react";
import assertNever from "assert-never";

export function RunsFilters() {
  const navigate = useNavigate();
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const { environment, status, from, to } = RunListSearchSchema.parse(
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

  const handleStatusChange = useCallback((value: FilterableStatus | "ALL") => {
    handleFilterChange("status", value === "ALL" ? undefined : value);
  }, []);

  const handleEnvironmentChange = useCallback((value: FilterableEnvironment | "ALL") => {
    handleFilterChange("environment", value === "ALL" ? undefined : value);
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
    searchParams.delete("status");
    searchParams.delete("environment");
    searchParams.delete("from");
    searchParams.delete("to");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  }, []);

  return (
    <div className="flex flex-row justify-between">
      <SelectGroup>
        <Select
          name="environment"
          value={environment ?? "ALL"}
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
            {environmentKeys.map((env) => (
              <SelectItem key={env} value={env}>
                <div className="flex items-center gap-x-2">
                  <EnvironmentLabel environment={{ type: env }} />
                  <Paragraph variant="extra-small">environment</Paragraph>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SelectGroup>

      <SelectGroup>
        <Select name="status" value={status ?? "ALL"} onValueChange={handleStatusChange}>
          <SelectTrigger size="minimal" width="full">
            <SelectValue placeholder="Select status" className="ml-2 p-0" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={"ALL"}>
              <Paragraph
                variant="extra-small"
                className="pl-0.5 transition group-hover:text-text-bright"
              >
                All statuses
              </Paragraph>
            </SelectItem>
            {statusKeys.map((status) => (
              <SelectItem key={status} value={status}>
                {
                  <span className="flex items-center gap-1 text-xs">
                    <FilterStatusIcon status={status} className="h-4 w-4" />
                    <FilterStatusLabel status={status} />
                  </span>
                }
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

export function FilterStatusLabel({ status }: { status: FilterableStatus }) {
  return <span className={filterStatusClassNameColor(status)}>{filterStatusTitle(status)}</span>;
}

export function FilterStatusIcon({
  status,
  className,
}: {
  status: FilterableStatus;
  className: string;
}) {
  switch (status) {
    case "COMPLETED":
      return <CheckCircleIcon className={cn(filterStatusClassNameColor(status), className)} />;
    case "WAITING":
      return <ClockIcon className={cn(filterStatusClassNameColor(status), className)} />;
    case "QUEUED":
      return <PauseCircleIcon className={cn(filterStatusClassNameColor(status), className)} />;
    case "IN_PROGRESS":
      return <Spinner className={cn(filterStatusClassNameColor(status), className)} />;
    case "TIMEDOUT":
      return (
        <ExclamationTriangleIcon className={cn(filterStatusClassNameColor(status), className)} />
      );
    case "CANCELED":
      return <NoSymbolIcon className={cn(filterStatusClassNameColor(status), className)} />;
    case "FAILED":
      return <XCircleIcon className={cn(filterStatusClassNameColor(status), className)} />;
    default: {
      assertNever(status);
    }
  }
}

export function filterStatusTitle(status: FilterableStatus): string {
  switch (status) {
    case "QUEUED":
      return "Queued";
    case "IN_PROGRESS":
      return "In progress";
    case "WAITING":
      return "Waiting";
    case "COMPLETED":
      return "Completed";
    case "FAILED":
      return "Failed";
    case "CANCELED":
      return "Canceled";
    case "TIMEDOUT":
      return "Timed out";
    default: {
      assertNever(status);
    }
  }
}

export function filterStatusClassNameColor(status: FilterableStatus): string {
  switch (status) {
    case "QUEUED":
      return "text-charcoal-500";
    case "IN_PROGRESS":
      return "text-blue-500";
    case "WAITING":
      return "text-blue-500";
    case "COMPLETED":
      return "text-green-500";
    case "FAILED":
      return "text-rose-500";
    case "CANCELED":
      return "text-charcoal-500";
    case "TIMEDOUT":
      return "text-amber-300";
    default: {
      assertNever(status);
    }
  }
}
