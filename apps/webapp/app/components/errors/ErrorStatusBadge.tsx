import { type ErrorGroupStatus } from "@trigger.dev/database";
import { cn } from "~/utils/cn";

// System themes fill the chip with the status color and drop to white text;
// Classic keeps the tinted look.
const styles: Record<ErrorGroupStatus, string> = {
  UNRESOLVED: "bg-error/10 text-error system:bg-error system:text-white",
  RESOLVED: "bg-success/10 text-success system:bg-success system:text-white",
  IGNORED: "bg-blue-500/10 text-blue-400 system:bg-blue-500 system:text-white",
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
