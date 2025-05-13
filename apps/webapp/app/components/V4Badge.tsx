import { cn } from "~/utils/cn";
import { Badge } from "./primitives/Badge";
import { SimpleTooltip } from "./primitives/Tooltip";

export function V4Badge({ inline = false, className }: { inline?: boolean; className?: string }) {
  return (
    <SimpleTooltip
      button={
        <Badge variant="extra-small" className={cn(inline ? "inline-grid" : "", className)}>
          V4
        </Badge>
      }
      content="This feature is only available in V4 and above."
      disableHoverableContent
    />
  );
}

export function V4Title({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span>{children}</span>
      <V4Badge />
    </>
  );
}
