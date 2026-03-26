import { type ErrorGroupStatus } from "@trigger.dev/database";
import { cn } from "~/utils/cn";

const styles: Record<ErrorGroupStatus, string> = {
  UNRESOLVED: "bg-error/10 text-error",
  RESOLVED: "bg-success/10 text-success",
  IGNORED: "bg-charcoal-750 text-text-dimmed",
};

const labels: Record<ErrorGroupStatus, string> = {
  UNRESOLVED: "Unresolved",
  RESOLVED: "Resolved",
  IGNORED: "Ignored",
};

export function ErrorStatusBadge({
  status,
  className,
}: {
  status: ErrorGroupStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-2 py-0.5 text-xs font-medium",
        styles[status],
        className
      )}
    >
      {labels[status]}
    </span>
  );
}
