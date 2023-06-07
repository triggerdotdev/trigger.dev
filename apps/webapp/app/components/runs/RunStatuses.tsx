import { JobRunStatus } from ".prisma/client";
import {
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  WrenchIcon,
  XCircleIcon,
} from "@heroicons/react/24/solid";
import { cn } from "~/utils/cn";
import { Spinner } from "../primitives/Spinner";

export function RunStatus({ status }: { status: JobRunStatus }) {
  return (
    <span className="flex items-center gap-1">
      <RunStatusIcon status={status} className="h-4 w-4" />
      <RunStatusLabel status={status} />
    </span>
  );
}

export function RunStatusLabel({ status }: { status: JobRunStatus }) {
  return (
    <span className={runStatusClassNameColor(status)}>
      {runStatusTitle(status)}
    </span>
  );
}

export function RunStatusIcon({
  status,
  className,
}: {
  status: JobRunStatus;
  className: string;
}) {
  switch (status) {
    case "SUCCESS":
      return (
        <CheckCircleIcon
          className={cn(runStatusClassNameColor(status), className)}
        />
      );
    case "PENDING":
      return (
        <ClockIcon className={cn(runStatusClassNameColor(status), className)} />
      );
    case "QUEUED":
      return (
        <ClockIcon className={cn(runStatusClassNameColor(status), className)} />
      );
    case "STARTED":
      return (
        <Spinner className={cn(runStatusClassNameColor(status), className)} />
      );
    case "FAILURE":
      return (
        <XCircleIcon
          className={cn(runStatusClassNameColor(status), className)}
        />
      );
    case "TIMED_OUT":
      return (
        <ExclamationTriangleIcon
          className={cn(runStatusClassNameColor(status), className)}
        />
      );
    case "WAITING_ON_CONNECTIONS":
      return (
        <WrenchIcon
          className={cn(runStatusClassNameColor(status), className)}
        />
      );
    case "ABORTED":
      return (
        <XCircleIcon
          className={cn(runStatusClassNameColor(status), className)}
        />
      );
    case "PREPROCESSING":
      return (
        <Spinner className={cn(runStatusClassNameColor(status), className)} />
      );
  }
}

export function runStatusTitle(status: JobRunStatus): string {
  switch (status) {
    case "SUCCESS":
      return "Completed";
    case "PENDING":
      return "Not started";
    case "STARTED":
      return "In progress";
    case "QUEUED":
      return "Queued";
    case "FAILURE":
      return "Failed";
    case "TIMED_OUT":
      return "Timed out";
    case "WAITING_ON_CONNECTIONS":
      return "Waiting on connections";
    case "ABORTED":
      return "Aborted";
    case "PREPROCESSING":
      return "Preprocessing";
  }
}

function runStatusClassNameColor(status: JobRunStatus): string {
  switch (status) {
    case "SUCCESS":
      return "text-green-500";
    case "PENDING":
      return "text-slate-500";
    case "STARTED":
      return "text-blue-500";
    case "QUEUED":
      return "text-amber-300";
    case "FAILURE":
      return "text-rose-500";
    case "TIMED_OUT":
      return "text-amber-300";
    case "WAITING_ON_CONNECTIONS":
      return "text-amber-300";
    case "ABORTED":
      return "text-rose-500";
    case "PREPROCESSING":
      return "text-blue-500";
  }
}
