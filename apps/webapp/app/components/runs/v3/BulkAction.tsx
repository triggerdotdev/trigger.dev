import { ArrowPathIcon, CheckCircleIcon, NoSymbolIcon } from "@heroicons/react/20/solid";
import { BulkActionStatus, type BulkActionType } from "@trigger.dev/database";
import assertNever from "assert-never";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

export function BulkActionTypeCombo({
  type,
  className,
  iconClassName,
  labelClassName,
}: {
  type: BulkActionType;
  className?: string;
  iconClassName?: string;
  labelClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <BulkActionIcon type={type} className={cn("h-4 w-4", iconClassName)} />
      <BulkActionLabel type={type} className={labelClassName} />
    </span>
  );
}

export function BulkActionLabel({ type, className }: { type: BulkActionType; className?: string }) {
  return <span className={cn("text-text-dimmed", className)}>{bulkActionTitle(type)}</span>;
}

export function BulkActionIcon({ type, className }: { type: BulkActionType; className: string }) {
  switch (type) {
    case "REPLAY":
      return <ArrowPathIcon className={cn(bulkActionClassName(type), className)} />;
    case "CANCEL":
      return <NoSymbolIcon className={cn(bulkActionClassName(type), className)} />;
    default: {
      assertNever(type);
    }
  }
}

export function bulkActionClassName(type: BulkActionType): string {
  switch (type) {
    case "REPLAY":
      return "text-indigo-500";
    case "CANCEL":
      return "text-rose-500";
    default: {
      assertNever(type);
    }
  }
}

export function bulkActionTitle(type: BulkActionType): string {
  switch (type) {
    case "REPLAY":
      return "Replay";
    case "CANCEL":
      return "Cancel";
    default: {
      assertNever(type);
    }
  }
}

export function bulkActionVerb(type: BulkActionType): string {
  switch (type) {
    case "REPLAY":
      return "Replaying";
    case "CANCEL":
      return "Canceling";
    default: {
      assertNever(type);
    }
  }
}

export function BulkActionStatusCombo({
  status,
  className,
  iconClassName,
  labelClassName,
}: {
  status: BulkActionStatus;
  className?: string;
  iconClassName?: string;
  labelClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <BulkActionStatusIcon status={status} className={cn("h-4 w-4", iconClassName)} />
      <BulkActionStatusLabel status={status} className={labelClassName} />
    </span>
  );
}

export function BulkActionStatusIcon({
  status,
  className,
}: {
  status: BulkActionStatus;
  className: string;
}) {
  switch (status) {
    case "PENDING":
      return <Spinner className={cn("text-pending", className)} />;
    case "COMPLETED":
      return <CheckCircleIcon className={cn("text-success", className)} />;
    case "ABORTED":
      return <NoSymbolIcon className={cn("text-error", className)} />;
    default: {
      assertNever(status);
    }
  }
}

export function BulkActionStatusLabel({
  status,
  className,
}: {
  status: BulkActionStatus;
  className?: string;
}) {
  switch (status) {
    case "PENDING":
      return <span className={cn("text-pending", className)}>In progress</span>;
    case "COMPLETED":
      return <span className={cn("text-success", className)}>Completed</span>;
    case "ABORTED":
      return <span className={cn("text-error", className)}>Aborted</span>;
    default: {
      assertNever(status);
    }
  }
}
