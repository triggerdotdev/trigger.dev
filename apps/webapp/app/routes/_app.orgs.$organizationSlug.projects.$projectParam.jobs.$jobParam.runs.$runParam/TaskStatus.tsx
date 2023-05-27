import { TaskStatus } from "@/../../packages/internal/src";
import {
  CheckCircleIcon,
  ClockIcon,
  XCircleIcon,
} from "@heroicons/react/24/solid";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

export function TaskStatusIcon({
  status,
  className,
}: {
  status: TaskStatus;
  className: string;
}) {
  switch (status) {
    case "COMPLETED":
      return (
        <CheckCircleIcon
          className={cn(taskStatusClassNameColor(status), className)}
        />
      );
    case "PENDING":
      return (
        <ClockIcon
          className={cn(taskStatusClassNameColor(status), className)}
        />
      );
    case "WAITING":
      return (
        <ClockIcon
          className={cn(taskStatusClassNameColor(status), className)}
        />
      );
    case "RUNNING":
      return (
        <Spinner className={cn(taskStatusClassNameColor(status), className)} />
      );
    case "ERRORED":
      return (
        <XCircleIcon
          className={cn(taskStatusClassNameColor(status), className)}
        />
      );
  }
}

function taskStatusClassNameColor(status: TaskStatus): string {
  switch (status) {
    case "COMPLETED":
      return "text-green-500";
    case "PENDING":
      return "text-slate-500";
    case "RUNNING":
      return "text-blue-500";
    case "WAITING":
      return "text-amber-300";
    case "ERRORED":
      return "text-rose-500";
  }
}
