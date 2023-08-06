import { CheckCircleIcon, ClockIcon, XCircleIcon } from "@heroicons/react/24/solid";
import type { TaskAttemptStatus } from "@trigger.dev/database";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

type TaskAttemptStatusProps = {
  status: TaskAttemptStatus;
  className?: string;
};

export function TaskAttemptStatusLabel({ status }: { status: TaskAttemptStatus }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <TaskAttemptStatusIcon status={status} className="h-4 w-4" />
      <Paragraph variant="extra-small" className={taskAttemptStatusClassNameColor(status)}>
        {taskAttemptStatusTitle(status)}
      </Paragraph>
    </span>
  );
}

export function TaskAttemptStatusIcon({ status, className }: TaskAttemptStatusProps) {
  switch (status) {
    case "COMPLETED":
      return <CheckCircleIcon className={cn(taskAttemptStatusClassNameColor(status), className)} />;
    case "PENDING":
      return <ClockIcon className={cn(taskAttemptStatusClassNameColor(status), className)} />;
    case "STARTED":
      return <Spinner className={cn(taskAttemptStatusClassNameColor(status), className)} />;
    case "ERRORED":
      return <XCircleIcon className={cn(taskAttemptStatusClassNameColor(status), className)} />;
  }
}

function taskAttemptStatusClassNameColor(status: TaskAttemptStatus): string {
  switch (status) {
    case "COMPLETED":
      return "text-green-500";
    case "PENDING":
      return "text-slate-400";
    case "STARTED":
      return "text-blue-500";
    case "ERRORED":
      return "text-rose-500";
  }
}

function taskAttemptStatusTitle(status: TaskAttemptStatus): string {
  switch (status) {
    case "COMPLETED":
      return "Complete";
    case "PENDING":
      return "Scheduled";
    case "STARTED":
      return "Running";
    case "ERRORED":
      return "Error";
  }
}
