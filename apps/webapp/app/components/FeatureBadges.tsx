import { cn } from "~/utils/cn";
import { Badge } from "./primitives/Badge";
import { SimpleTooltip } from "./primitives/Tooltip";

export function AlphaBadge({
  inline = false,
  className,
}: {
  inline?: boolean;
  className?: string;
}) {
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
          Alpha
        </Badge>
      }
      content="This feature is in Alpha"
      disableHoverableContent
    />
  );
}

function AlphaTitle({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span>{children}</span>
      <AlphaBadge />
    </>
  );
}

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

function BetaTitle({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span>{children}</span>
      <BetaBadge />
    </>
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
