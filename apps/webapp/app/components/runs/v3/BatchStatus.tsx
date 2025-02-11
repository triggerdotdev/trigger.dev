import { CheckCircleIcon, XCircleIcon } from "@heroicons/react/20/solid";
import { BatchTaskRunStatus } from "@trigger.dev/database";
import assertNever from "assert-never";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

export const allBatchStatuses = ["PENDING", "COMPLETED", "ABORTED"] as const satisfies Readonly<
  Array<BatchTaskRunStatus>
>;

const descriptions: Record<BatchTaskRunStatus, string> = {
  PENDING: "The batch has child runs that have not yet completed.",
  COMPLETED: "All the batch child runs have finished.",
  ABORTED: "The batch was aborted because some child tasks could not be triggered.",
};

export function descriptionForBatchStatus(status: BatchTaskRunStatus): string {
  return descriptions[status];
}

export function BatchStatusCombo({
  status,
  className,
  iconClassName,
}: {
  status: BatchTaskRunStatus;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <BatchStatusIcon status={status} className={cn("h-4 w-4", iconClassName)} />
      <BatchStatusLabel status={status} />
    </span>
  );
}

export function BatchStatusLabel({ status }: { status: BatchTaskRunStatus }) {
  return <span className={batchStatusColor(status)}>{batchStatusTitle(status)}</span>;
}

export function BatchStatusIcon({
  status,
  className,
}: {
  status: BatchTaskRunStatus;
  className: string;
}) {
  switch (status) {
    case "PENDING":
      return <Spinner className={cn(batchStatusColor(status), className)} />;
    case "COMPLETED":
      return <CheckCircleIcon className={cn(batchStatusColor(status), className)} />;
    case "ABORTED":
      return <XCircleIcon className={cn(batchStatusColor(status), className)} />;
    default: {
      assertNever(status);
    }
  }
}

export function batchStatusColor(status: BatchTaskRunStatus): string {
  switch (status) {
    case "PENDING":
      return "text-pending";
    case "COMPLETED":
      return "text-success";
    case "ABORTED":
      return "text-error";
    default: {
      assertNever(status);
    }
  }
}

export function batchStatusTitle(status: BatchTaskRunStatus): string {
  switch (status) {
    case "PENDING":
      return "In progress";
    case "COMPLETED":
      return "Completed";
    case "ABORTED":
      return "Aborted";
    default: {
      assertNever(status);
    }
  }
}
