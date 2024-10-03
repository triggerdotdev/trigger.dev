import {
  ArrowPathIcon,
  BoltSlashIcon,
  BugAntIcon,
  CheckCircleIcon,
  ClockIcon,
  FireIcon,
  NoSymbolIcon,
  PauseCircleIcon,
  RectangleStackIcon,
  StopIcon,
  TrashIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import { TaskRunStatus } from "@trigger.dev/database";
import assertNever from "assert-never";
import { SnowflakeIcon } from "lucide-react";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

export const allTaskRunStatuses = [
  "DELAYED",
  "WAITING_FOR_DEPLOY",
  "PENDING",
  "EXECUTING",
  "RETRYING_AFTER_FAILURE",
  "WAITING_TO_RESUME",
  "COMPLETED_SUCCESSFULLY",
  "CANCELED",
  "COMPLETED_WITH_ERRORS",
  "TIMED_OUT",
  "CRASHED",
  "PAUSED",
  "INTERRUPTED",
  "SYSTEM_FAILURE",
  "EXPIRED",
] as const satisfies Readonly<Array<TaskRunStatus>>;

export const filterableTaskRunStatuses = [
  "WAITING_FOR_DEPLOY",
  "DELAYED",
  "PENDING",
  "EXECUTING",
  "RETRYING_AFTER_FAILURE",
  "WAITING_TO_RESUME",
  "COMPLETED_SUCCESSFULLY",
  "CANCELED",
  "COMPLETED_WITH_ERRORS",
  "TIMED_OUT",
  "CRASHED",
  "INTERRUPTED",
  "SYSTEM_FAILURE",
  "EXPIRED",
] as const satisfies Readonly<Array<TaskRunStatus>>;

const taskRunStatusDescriptions: Record<TaskRunStatus, string> = {
  DELAYED: "Task has been delayed and is waiting to be executed",
  PENDING: "Task is waiting to be executed",
  WAITING_FOR_DEPLOY: "Task needs to be deployed first to start executing",
  EXECUTING: "Task is currently being executed",
  RETRYING_AFTER_FAILURE: "Task is being reattempted after a failure",
  WAITING_TO_RESUME: "Task has been frozen and is waiting to be resumed",
  COMPLETED_SUCCESSFULLY: "Task has been successfully completed",
  CANCELED: "Task has been canceled",
  COMPLETED_WITH_ERRORS: "Task has failed with errors",
  INTERRUPTED: "Task has failed because it was interrupted",
  SYSTEM_FAILURE: "Task has failed due to a system failure",
  PAUSED: "Task has been paused by the user",
  CRASHED: "Task has crashed and won't be retried",
  EXPIRED: "Task has surpassed its ttl and won't be executed",
  TIMED_OUT: "Task has reached it's maxDuration and has been stopped",
};

export const QUEUED_STATUSES = [
  "PENDING",
  "WAITING_FOR_DEPLOY",
  "DELAYED",
] satisfies TaskRunStatus[];

export const RUNNING_STATUSES = [
  "EXECUTING",
  "RETRYING_AFTER_FAILURE",
  "WAITING_TO_RESUME",
] satisfies TaskRunStatus[];

export function descriptionForTaskRunStatus(status: TaskRunStatus): string {
  return taskRunStatusDescriptions[status];
}

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
    case "DELAYED":
      return <ClockIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "PENDING":
      return <RectangleStackIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "WAITING_FOR_DEPLOY":
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
    case "CRASHED":
      return <FireIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "EXPIRED":
      return <TrashIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "TIMED_OUT":
      return <StopIcon className={cn(runStatusClassNameColor(status), className)} />;

    default: {
      assertNever(status);
    }
  }
}

export function runStatusClassNameColor(status: TaskRunStatus): string {
  switch (status) {
    case "PENDING":
    case "DELAYED":
      return "text-charcoal-500";
    case "WAITING_FOR_DEPLOY":
      return "text-amber-500";
    case "EXECUTING":
    case "RETRYING_AFTER_FAILURE":
      return "text-pending";
    case "WAITING_TO_RESUME":
      return "text-sky-300";
    case "PAUSED":
      return "text-amber-300";
    case "CANCELED":
    case "EXPIRED":
      return "text-charcoal-500";
    case "INTERRUPTED":
      return "text-error";
    case "COMPLETED_SUCCESSFULLY":
      return "text-success";
    case "COMPLETED_WITH_ERRORS":
      return "text-error";
    case "SYSTEM_FAILURE":
      return "text-error";
    case "CRASHED":
      return "text-error";
    case "TIMED_OUT":
      return "text-error";
    default: {
      assertNever(status);
    }
  }
}

export function runStatusTitle(status: TaskRunStatus): string {
  switch (status) {
    case "DELAYED":
      return "Delayed";
    case "PENDING":
      return "Queued";
    case "WAITING_FOR_DEPLOY":
      return "Waiting for deploy";
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
    case "CRASHED":
      return "Crashed";
    case "EXPIRED":
      return "Expired";
    case "TIMED_OUT":
      return "Timed out";
    default: {
      assertNever(status);
    }
  }
}
