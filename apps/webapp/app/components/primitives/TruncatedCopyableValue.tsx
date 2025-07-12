import { cn } from "~/utils/cn";
import { CopyableText } from "./CopyableText";
import { SimpleTooltip } from "./Tooltip";

export function TruncatedCopyableValue({
  value,
  className,
  length = 8,
}: {
  value: string;
  className?: string;
  length?: number;
}) {
  return (
    <SimpleTooltip
      content={value}
      button={
        <span className={cn("flex h-6 items-center gap-1", className)}>
          <CopyableText value={value.slice(-length)} copyValue={value} className="font-mono" />
        </span>
      }
      asChild
      disableHoverableContent
    />
  );
}
