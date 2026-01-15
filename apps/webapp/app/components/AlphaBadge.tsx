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
        <Badge variant="extra-small" className={cn(inline ? "inline-grid" : "", className)}>
          Alpha
        </Badge>
      }
      content="This feature is in Alpha."
      disableHoverableContent
    />
  );
}

export function AlphaTitle({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span>{children}</span>
      <AlphaBadge />
    </>
  );
}
