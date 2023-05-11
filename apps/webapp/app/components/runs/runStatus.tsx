import {
  ClockIcon,
  XCircleIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/solid";
import type { ReactNode } from "react";
import { Spinner } from "../primitives/Spinner";
import { cn } from "~/utils/cn";

export function runStatusTitle(status: WorkflowRunStatus): string {
  switch (status) {
    case "SUCCESS":
      return "Complete";
    case "PENDING":
      return "Not started";
    case "RUNNING":
      return "In progress";
    case "DISCONNECTED":
      return "Disconnected";
    case "ERROR":
      return "Error";
    case "TIMED_OUT":
      return "Timed out";
  }
}

export function runStatusLabel(status: WorkflowRunStatus): ReactNode {
  switch (status) {
    case "SUCCESS":
      return <span className="text-green-500">{runStatusTitle(status)}</span>;
    case "PENDING":
      return <span className="text-slate-500">{runStatusTitle(status)}</span>;
    case "RUNNING":
      return <span className="text-blue-500">{runStatusTitle(status)}</span>;
    case "DISCONNECTED":
      return <span className="text-amber-300">{runStatusTitle(status)}</span>;
    case "ERROR":
      return <span className="text-rose-500">{runStatusTitle(status)}</span>;
    case "TIMED_OUT":
      return <span className="text-amber-300">{runStatusTitle(status)}</span>;
  }
}

export function RunStatusIcon(
  status: WorkflowRunStatus,
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
    case "RUNNING":
      return (
        <Spinner
          className={cn(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative ml-[1px] text-blue-500"
          )}
        />
      );
    case "DISCONNECTED":
      return (
        <ExclamationTriangleIcon
          className={cn(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-amber-300"
          )}
        />
      );
    case "ERROR":
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
