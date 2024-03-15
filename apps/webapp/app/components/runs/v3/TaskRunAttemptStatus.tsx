import {
  CheckCircleIcon,
  ClockIcon,
  NoSymbolIcon,
  PauseCircleIcon,
  RectangleStackIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import type { TaskRunAttemptStatus as TaskRunAttemptStatusType } from "@trigger.dev/database";
import { TaskRunAttemptStatus } from "@trigger.dev/database";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

export const allTaskRunAttemptStatuses = Object.values(
  TaskRunAttemptStatus
) as TaskRunAttemptStatusType[];

export type ExtendedTaskAttemptStatus = (typeof allTaskRunAttemptStatuses)[number] | "ENQUEUED";

export function TaskRunAttemptStatusCombo({
  status,
  className,
}: {
  status: ExtendedTaskAttemptStatus | null;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <TaskRunAttemptStatusIcon status={status} className="h-4 w-4" />
      <TaskRunAttemptStatusLabel status={status} />
    </span>
  );
}

export function TaskRunAttemptStatusLabel({
  status,
}: {
  status: ExtendedTaskAttemptStatus | null;
}) {
  return (
    <span className={runAttemptStatusClassNameColor(status)}>{runAttemptStatusTitle(status)}</span>
  );
}

export function TaskRunAttemptStatusIcon({
  status,
  className,
}: {
  status: ExtendedTaskAttemptStatus | null;
  className: string;
}) {
  if (status === null) {
    return <RectangleStackIcon className={cn(runAttemptStatusClassNameColor(status), className)} />;
  }

  switch (status) {
    case "ENQUEUED":
      return (
        <RectangleStackIcon className={cn(runAttemptStatusClassNameColor(status), className)} />
      );
    case "PENDING":
      return <ClockIcon className={cn(runAttemptStatusClassNameColor(status), className)} />;
    case "EXECUTING":
      return <Spinner className={cn(runAttemptStatusClassNameColor(status), className)} />;
    case "PAUSED":
      return <PauseCircleIcon className={cn(runAttemptStatusClassNameColor(status), className)} />;
    case "FAILED":
      return <XCircleIcon className={cn(runAttemptStatusClassNameColor(status), className)} />;
    case "CANCELED":
      return <NoSymbolIcon className={cn(runAttemptStatusClassNameColor(status), className)} />;
    case "COMPLETED":
      return <CheckCircleIcon className={cn(runAttemptStatusClassNameColor(status), className)} />;
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}

export function runAttemptStatusClassNameColor(status: ExtendedTaskAttemptStatus | null): string {
  if (status === null) {
    return "text-charcoal-500";
  }

  switch (status) {
    case "ENQUEUED":
      return "text-charcoal-500";
    case "PENDING":
      return "text-charcoal-500";
    case "EXECUTING":
      return "text-pending";
    case "PAUSED":
      return "text-amber-300";
    case "FAILED":
      return "text-error";
    case "CANCELED":
      return "text-charcoal-500";
    case "COMPLETED":
      return "text-success";
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}

export function runAttemptStatusTitle(status: ExtendedTaskAttemptStatus | null): string {
  if (status === null) {
    return "Enqueued";
  }

  switch (status) {
    case "ENQUEUED":
      return "Enqueued";
    case "PENDING":
      return "Pending";
    case "EXECUTING":
      return "Executing";
    case "PAUSED":
      return "Paused";
    case "FAILED":
      return "Failed";
    case "CANCELED":
      return "Canceled";
    case "COMPLETED":
      return "Completed";
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}
