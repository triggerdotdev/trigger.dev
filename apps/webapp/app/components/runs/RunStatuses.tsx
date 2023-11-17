import { NoSymbolIcon } from "@heroicons/react/20/solid";
import {
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  WrenchIcon,
  XCircleIcon,
} from "@heroicons/react/24/solid";
import type { JobRunStatus } from "@trigger.dev/database";
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
  return <span className={runStatusClassNameColor(status)}>{runStatusTitle(status)}</span>;
}

export function RunStatusIcon({ status, className }: { status: JobRunStatus; className: string }) {
  switch (status) {
    case "SUCCESS":
      return <CheckCircleIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "PENDING":
    case "QUEUED":
      return <ClockIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "PREPROCESSING":
    case "STARTED":
    case "WAITING_TO_CONTINUE":
    case "WAITING_TO_EXECUTE":
    case "EXECUTING":
      return <Spinner className={cn(runStatusClassNameColor(status), className)} />;
    case "TIMED_OUT":
      return <ExclamationTriangleIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "UNRESOLVED_AUTH":
    case "FAILURE":
    case "ABORTED":
    case "INVALID_PAYLOAD":
      return <XCircleIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "WAITING_ON_CONNECTIONS":
      return <WrenchIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "CANCELED":
      return <NoSymbolIcon className={cn(runStatusClassNameColor(status), className)} />;
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
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
    case "EXECUTING":
      return "Executing";
    case "WAITING_TO_CONTINUE":
      return "Waiting";
    case "WAITING_TO_EXECUTE":
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
    case "CANCELED":
      return "Canceled";
    case "UNRESOLVED_AUTH":
      return "Unresolved auth";
    case "INVALID_PAYLOAD":
      return "Invalid payload";
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}

export function runStatusClassNameColor(status: JobRunStatus): string {
  switch (status) {
    case "SUCCESS":
      return "text-green-500";
    case "PENDING":
      return "text-slate-500";
    case "STARTED":
    case "EXECUTING":
    case "WAITING_TO_CONTINUE":
    case "WAITING_TO_EXECUTE":
      return "text-blue-500";
    case "QUEUED":
      return "text-amber-300";
    case "FAILURE":
    case "UNRESOLVED_AUTH":
    case "INVALID_PAYLOAD":
      return "text-rose-500";
    case "TIMED_OUT":
      return "text-amber-300";
    case "WAITING_ON_CONNECTIONS":
      return "text-amber-300";
    case "ABORTED":
      return "text-rose-500";
    case "PREPROCESSING":
      return "text-blue-500";
    case "CANCELED":
      return "text-slate-500";
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}
