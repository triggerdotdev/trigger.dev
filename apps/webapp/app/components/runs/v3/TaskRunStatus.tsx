import {
  CheckCircleIcon,
  ClockIcon,
  NoSymbolIcon,
  PauseCircleIcon,
  RectangleStackIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";
import { ExtendedTaskAttemptStatus } from "./RunFilters";

export function TaskRunStatus({ status }: { status: ExtendedTaskAttemptStatus | null }) {
  return (
    <span className="flex items-center gap-1">
      <TaskRunStatusIcon status={status} className="h-4 w-4" />
      <TaskRunStatusLabel status={status} />
    </span>
  );
}

export function TaskRunStatusLabel({ status }: { status: ExtendedTaskAttemptStatus | null }) {
  return <span className={runStatusClassNameColor(status)}>{runStatusTitle(status)}</span>;
}

export function TaskRunStatusIcon({
  status,
  className,
}: {
  status: ExtendedTaskAttemptStatus | null;
  className: string;
}) {
  if (status === null) {
    return <RectangleStackIcon className={cn(runStatusClassNameColor(status), className)} />;
  }

  switch (status) {
    case "ENQUEUED":
      return <RectangleStackIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "PENDING":
      return <ClockIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "EXECUTING":
      return <Spinner className={cn(runStatusClassNameColor(status), className)} />;
    case "PAUSED":
      return <PauseCircleIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "FAILED":
      return <XCircleIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "CANCELED":
      return <NoSymbolIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "COMPLETED":
      return <CheckCircleIcon className={cn(runStatusClassNameColor(status), className)} />;

    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}

export function runStatusClassNameColor(status: ExtendedTaskAttemptStatus | null): string {
  if (status === null) {
    return "text-slate-500";
  }

  switch (status) {
    case "ENQUEUED":
      return "text-slate-500";
    case "PENDING":
      return "text-slate-500";
    case "EXECUTING":
      return "text-blue-500";
    case "PAUSED":
      return "text-amber-300";
    case "FAILED":
      return "text-rose-500";
    case "CANCELED":
      return "text-slate-500";
    case "COMPLETED":
      return "text-green-500";
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}

export function runStatusTitle(status: ExtendedTaskAttemptStatus | null): string {
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
