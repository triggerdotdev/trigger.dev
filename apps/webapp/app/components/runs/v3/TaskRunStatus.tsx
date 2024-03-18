import {
  ArrowPathIcon,
  BoltSlashIcon,
  BugAntIcon,
  CheckCircleIcon,
  ClockIcon,
  NoSymbolIcon,
  PauseCircleIcon,
  RectangleStackIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import { TaskRunStatus } from "@trigger.dev/database";
import { SnowflakeIcon } from "lucide-react";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

export function TaskRunStatusCombo({
  status,
  className,
  iconClassName,
}: {
  status: TaskRunStatus;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <TaskRunStatusIcon status={status} className={cn("h-4 w-4", iconClassName)} />
      <TaskRunStatusLabel status={status} />
    </span>
  );
}

export function TaskRunStatusLabel({ status }: { status: TaskRunStatus }) {
  return <span className={runStatusClassNameColor(status)}>{runStatusTitle(status)}</span>;
}

export function TaskRunStatusIcon({
  status,
  className,
}: {
  status: TaskRunStatus;
  className: string;
}) {
  switch (status) {
    case "PENDING":
      return <RectangleStackIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "EXECUTING":
      return <Spinner className={cn(runStatusClassNameColor(status), className)} />;
    case "WAITING_TO_RESUME":
      return <SnowflakeIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "RETRYING_AFTER_FAILURE":
      return <ArrowPathIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "PAUSED":
      return <PauseCircleIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "CANCELED":
      return <NoSymbolIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "INTERRUPTED":
      return <BoltSlashIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "COMPLETED_SUCCESSFULLY":
      return <CheckCircleIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "COMPLETED_WITH_ERRORS":
      return <XCircleIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "SYSTEM_FAILURE":
      return <BugAntIcon className={cn(runStatusClassNameColor(status), className)} />;

    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}

export function runStatusClassNameColor(status: TaskRunStatus): string {
  switch (status) {
    case "PENDING":
      return "text-charcoal-500";
    case "EXECUTING":
    case "RETRYING_AFTER_FAILURE":
      return "text-pending";
    case "WAITING_TO_RESUME":
      return "text-sky-300";
    case "PAUSED":
      return "text-amber-300";
    case "CANCELED":
      return "text-charcoal-500";
    case "INTERRUPTED":
      return "text-error";
    case "COMPLETED_SUCCESSFULLY":
      return "text-success";
    case "COMPLETED_WITH_ERRORS":
      return "text-error";
    case "SYSTEM_FAILURE":
      return "text-error";
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}

export function runStatusTitle(status: TaskRunStatus): string {
  switch (status) {
    case "PENDING":
      return "Queued";
    case "EXECUTING":
      return "Executing";
    case "WAITING_TO_RESUME":
      return "Frozen";
    case "RETRYING_AFTER_FAILURE":
      return "Reattempting";
    case "PAUSED":
      return "Paused";
    case "CANCELED":
      return "Canceled";
    case "INTERRUPTED":
      return "Interrupted";
    case "COMPLETED_SUCCESSFULLY":
      return "Completed";
    case "COMPLETED_WITH_ERRORS":
      return "Failed";
    case "SYSTEM_FAILURE":
      return "System failure";
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}
