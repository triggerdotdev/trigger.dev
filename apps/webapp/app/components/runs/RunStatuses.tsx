import {
  ClockIcon,
  XCircleIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/solid";
import type { ReactNode } from "react";
import { Spinner } from "../primitives/Spinner";
import { cn } from "~/utils/cn";
import { JobRunStatus } from ".prisma/client";

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
  }
}

export function runStatusClassNameColor(status: JobRunStatus): string {
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
  }
}

export function RunStatusLabel(status: JobRunStatus): ReactNode {
  switch (status) {
    case "SUCCESS":
      return <span className="text-green-500">{runStatusTitle(status)}</span>;
    case "PENDING":
      return <span className="text-slate-500">{runStatusTitle(status)}</span>;
    case "STARTED":
      return <span className="text-blue-500">{runStatusTitle(status)}</span>;
    case "QUEUED":
      return <span className="text-amber-300">{runStatusTitle(status)}</span>;
    case "FAILURE":
      return <span className="text-rose-500">{runStatusTitle(status)}</span>;
    case "TIMED_OUT":
      return <span className="text-amber-300">{runStatusTitle(status)}</span>;
  }
}

export function RunStatusIcon(
  status: JobRunStatus,
  iconSize: "small" | "large"
) {
  const largeClasses = "relative h-7 w-7";
  const smallClasses = "relative h-4 w-4";
  switch (status) {
    case "SUCCESS":
      return (
        <CheckCircleIcon
          className={cn(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-green-500"
          )}
        />
      );
    case "PENDING":
      return (
        <ClockIcon
          className={cn(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-slate-500"
          )}
        />
      );
    case "QUEUED":
      return (
        <ClockIcon
          className={cn(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-slate-500"
          )}
        />
      );
    case "STARTED":
      return (
        <Spinner
          className={cn(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative ml-[1px] text-blue-500"
          )}
        />
      );
    case "FAILURE":
      return (
        <XCircleIcon
          className={cn(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-rose-500"
          )}
        />
      );
    case "TIMED_OUT":
      return (
        <ExclamationTriangleIcon
          className={cn(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-amber-300"
          )}
        />
      );
  }
}
