import { cn } from "~/utils/cn";
import { Badge } from "./primitives/Badge";
import { SimpleTooltip } from "./primitives/Tooltip";

export function BetaBadge({ inline = false, className }: { inline?: boolean; className?: string }) {
  return (
    <SimpleTooltip
      button={
        <Badge
          variant="extra-small"
          className={cn(
            "system:border-transparent system:bg-blue-500 system:text-white",
            inline ? "inline-grid" : "",
            className
          )}
        >
          Beta
        </Badge>
      }
      content="This feature is in Beta"
      disableHoverableContent
    />
  );
}

export function NewBadge({ inline = false, className }: { inline?: boolean; className?: string }) {
  return (
    <Badge
      variant="extra-small"
      className={cn(
        "text-success system:border-transparent system:bg-success system:text-white",
        inline ? "inline-grid" : "",
        className
      )}
    >
      New
    </Badge>
  );
}

/** For something being phased out. Name its replacement in `tooltip`. */
export function DeprecatedBadge({
  tooltip,
  inline = false,
  className,
}: {
  tooltip: string;
  inline?: boolean;
  className?: string;
}) {
  return (
    <SimpleTooltip
      asChild
      button={
        <Badge
          variant="extra-small"
          className={cn(
            "text-warning system:border-transparent system:bg-warning system:text-white",
            inline ? "inline-grid" : "",
            className
          )}
        >
          Deprecated
        </Badge>
      }
      content={tooltip}
      disableHoverableContent
    />
  );
}

/** For an older way that still works. Name the newer option in `tooltip`. */
export function LegacyBadge({
  tooltip,
  inline = false,
  className,
}: {
  tooltip: string;
  inline?: boolean;
  className?: string;
}) {
  return (
    <SimpleTooltip
      asChild
      button={
        <Badge
          variant="extra-small"
          className={cn(
            "text-text-dimmed system:border-transparent system:bg-charcoal-500 system:text-white",
            inline ? "inline-grid" : "",
            className
          )}
        >
          Legacy
        </Badge>
      }
      content={tooltip}
      disableHoverableContent
    />
  );
}
