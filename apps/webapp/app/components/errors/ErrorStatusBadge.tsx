import { type ErrorGroupStatus } from "@trigger.dev/database";
import { cn } from "~/utils/cn";

// Two prominence levels: `subtle` keeps the tinted look for dense lists,
// `bright` fills the chip with the status color in the System themes for
// solitary placements (detail headers). Classic always uses the tinted look.
const subtleStyles: Record<ErrorGroupStatus, string> = {
  UNRESOLVED: "bg-error/10 text-error",
  RESOLVED: "bg-success/10 text-success",
  IGNORED: "bg-blue-500/10 text-blue-400 system:text-blue-500",
};

const brightStyles: Record<ErrorGroupStatus, string> = {
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
  prominence = "subtle",
}: {
  status: ErrorGroupStatus;
  className?: string;
  prominence?: "subtle" | "bright";
}) {
  return (
    <span
      className={cn(
        "contrast-chip inline-flex items-center rounded px-2 py-0.5 text-xs font-medium",
        // Only `bright` fills solid under the preference, so only it drops the ring.
        prominence === "bright" && "contrast-chip-solid",
        (prominence === "bright" ? brightStyles : subtleStyles)[status],
        className
      )}
    >
      {labels[status]}
    </span>
  );
}
