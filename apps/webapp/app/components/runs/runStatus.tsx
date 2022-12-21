import {
  ClockIcon,
  XCircleIcon,
  CheckCircleIcon,
} from "@heroicons/react/24/solid";
import classNames from "classnames";

import type { ReactNode } from "react";
import type { WorkflowRunStatus } from "~/models/workflowRun.server";
import { Spinner } from "../primitives/Spinner";

export function runStatusTitle(status: WorkflowRunStatus): ReactNode {
  switch (status) {
    case "SUCCESS":
      return <span className="text-green-500">Complete</span>;
    case "PENDING":
      return <span className="text-slate-500">Not started</span>;
    case "RUNNING":
      return <span className="text-blue-500">In progress</span>;
    case "ERROR":
      return <span className="text-red-500">Error</span>;
  }
}

export function runStatusIcon(
  status: WorkflowRunStatus,
  iconSize: "small" | "large"
): ReactNode {
  const largeClasses = "relative h-7 w-7";
  const smallClasses = "relative h-4 w-4";
  switch (status) {
    case "SUCCESS":
      return (
        <CheckCircleIcon
          className={classNames(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-green-500"
          )}
        />
      );
    case "PENDING":
      return (
        <ClockIcon
          className={classNames(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-slate-500"
          )}
        />
      );
    case "RUNNING":
      return (
        <Spinner
          className={classNames(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-blue-500 ml-[1px]"
          )}
        />
      );
    case "ERROR":
      return (
        <XCircleIcon
          className={classNames(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-red-500"
          )}
        />
      );
  }
}
