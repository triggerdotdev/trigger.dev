import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";
import { useState } from "react";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useCopy } from "~/hooks/useCopy";
import { cn } from "~/utils/cn";
import { Button } from "./Buttons";

export function CopyableText({
  value,
  copyValue,
  className,
  asChild,
  variant,
  hideTooltip,
  truncate,
}: {
  value: string;
  copyValue?: string;
  className?: string;
  asChild?: boolean;
  variant?: "icon-right" | "text-below";
  /**
   * Hide the "Copy"/"Copied" hint tooltip. Use when this is rendered inside another
   * Radix tooltip (e.g. the admin debug panel): the nested tooltip would otherwise
   * fire Radix's global "one tooltip open at a time" close and dismiss the parent.
   */
  hideTooltip?: boolean;
  /**
   * Ellipsise the value rather than letting it overflow its column. For unbreakable strings
   * (hashes, opaque ids) that offer no wrap opportunity. The copy button moves into a reserved
   * right gutter so it stays visible instead of sitting outside the column.
   */
  truncate?: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const { copy, copied } = useCopy(copyValue ?? value);

  const resolvedVariant = variant ?? "icon-right";

  if (resolvedVariant === "icon-right") {
    const iconButton = (
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy"}
        onClick={copy}
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          "ml-1 flex size-6 items-center justify-center rounded border border-border-bright bg-background-hover",
          asChild && "p-1",
          copied
            ? "text-green-500"
            : "text-text-dimmed hover:border-border-bright hover:bg-background-raised hover:text-text-bright"
        )}
      >
        {copied ? (
          <ClipboardCheckIcon className="size-3.5" />
        ) : (
          <ClipboardIcon className="size-3.5" />
        )}
      </button>
    );

    return (
      <span
        className={cn(
          "group relative inline-flex h-6 items-center",
          truncate && "max-w-full pr-7",
          className
        )}
        onMouseLeave={() => setIsHovered(false)}
      >
        <span
          className={cn(truncate && "min-w-0 truncate")}
          onMouseEnter={() => setIsHovered(true)}
        >
          {value}
        </span>
        <span
          className={cn(
            "absolute top-0 z-10 flex size-6 font-sans transition-opacity focus-within:opacity-100",
            // Truncated values reserve a right gutter, so the button sits inside it
            truncate ? "right-0" : "-right-6",
            isHovered ? "opacity-100" : "pointer-events-none opacity-0"
          )}
        >
          {hideTooltip ? (
            iconButton
          ) : (
            <SimpleTooltip
              asChild
              tabbable
              button={iconButton}
              content={copied ? "Copied!" : "Copy"}
              className="font-sans"
              disableHoverableContent
            />
          )}
        </span>
      </span>
    );
  }

  if (resolvedVariant === "text-below") {
    return (
      <SimpleTooltip
        button={
          <Button
            variant="minimal/small"
            onClick={(e) => {
              e.stopPropagation();
              copy();
            }}
            className={cn(
              "cursor-pointer bg-transparent px-1 py-0 text-left text-text-dimmed transition-colors hover:bg-transparent",
              className
            )}
          >
            <span className="transition-colors group-hover/button:text-text-bright">{value}</span>
          </Button>
        }
        content={copied ? "Copied" : "Copy"}
        className="px-2 py-1 font-sans"
        disableHoverableContent
        open={isHovered || copied}
        onOpenChange={setIsHovered}
        asChild
      />
    );
  }

  return null;
}
