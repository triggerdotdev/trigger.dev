import { ArrowPathIcon, NoSymbolIcon } from "@heroicons/react/20/solid";
import { type BulkActionType } from "@trigger.dev/database";
import assertNever from "assert-never";
import { cn } from "~/utils/cn";

export function BulkActionStatusCombo({
  type,
  className,
  iconClassName,
}: {
  type: BulkActionType;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <BulkActionIcon type={type} className={cn("h-4 w-4", iconClassName)} />
      <BulkActionLabel type={type} />
    </span>
  );
}

export function BulkActionLabel({ type }: { type: BulkActionType }) {
  return <span className={bulkActionClassName(type)}>{bulkActionTitle(type)}</span>;
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
