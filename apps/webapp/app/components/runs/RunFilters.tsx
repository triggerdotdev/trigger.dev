import { cn } from "~/utils/cn";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import { useLocation, useNavigate } from "@remix-run/react";
import {
  FilterableEnvironment,
  FilterableStatus,
  RunListSearchSchema,
  environmentKeys,
  statusKeys,
} from "./RunStatuses";
import { EnvironmentLabel, environmentTitle } from "../environments/EnvironmentLabel";
import {
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  NoSymbolIcon,
  PauseCircleIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import { Spinner } from "../primitives/Spinner";
import { Paragraph } from "../primitives/Paragraph";

export function RunsFilters() {
  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const { environment, status } = RunListSearchSchema.parse(
    Object.fromEntries(searchParams.entries())
  );

  const handleFilterChange = (filterType: string, value: string | undefined) => {
    if (value) {
      searchParams.set(filterType, value);
    } else {
      searchParams.delete(filterType);
    }
    searchParams.delete("cursor");
    searchParams.delete("direction");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  };

  const handleStatusChange = (value: FilterableStatus | "ALL") => {
    handleFilterChange("status", value === "ALL" ? undefined : value);
  };

  const handleEnvironmentChange = (value: FilterableEnvironment | "ALL") => {
    handleFilterChange("environment", value === "ALL" ? undefined : value);
  };

  return (
    <div className="flex flex-row justify-between gap-x-2">
      <SelectGroup>
        <Select
          name="environment"
          value={environment ?? "ALL"}
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
          <SelectTrigger size="secondary/small" width="full">
            <SelectValue placeholder="Select status" className="ml-2 p-0" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={"ALL"}>
              <Paragraph variant="extra-small" className="pl-0.5">
                All statuses
              </Paragraph>
            </SelectItem>
            {statusKeys.map((status) => (
              <SelectItem key={status} value={status}>
                {
                  <span className="flex items-center gap-1 text-xxs font-medium uppercase tracking-wider">
                    <FilterStatusIcon status={status} className="h-4 w-4" />
                    <FilterStatusLabel status={status} />
                  </span>
                }
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SelectGroup>
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
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
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
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}

export function filterStatusClassNameColor(status: FilterableStatus): string {
  switch (status) {
    case "QUEUED":
      return "text-slate-500";
    case "IN_PROGRESS":
      return "text-blue-500";
    case "WAITING":
      return "text-blue-500";
    case "COMPLETED":
      return "text-green-500";
    case "FAILED":
      return "text-rose-500";
    case "CANCELED":
      return "text-slate-500";
    case "TIMEDOUT":
      return "text-amber-300";
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}
