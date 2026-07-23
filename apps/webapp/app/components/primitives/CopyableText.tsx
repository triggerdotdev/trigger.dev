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
  ariaLabel,
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
  /** Accessible label for the copy button. Defaults to "Copy". */
  ariaLabel?: string;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const { copy, copied } = useCopy(copyValue ?? value);

  const resolvedVariant = variant ?? "icon-right";

  if (resolvedVariant === "icon-right") {
    // Real button semantics so keyboard and touch users can discover and trigger copying.
    // The affordance is revealed on row hover, keyboard focus, and coarse (touch) pointers.
    const iconButton = (
      <button
        type="button"
        onClick={copy}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label={copied ? "Copied!" : (ariaLabel ?? "Copy")}
        className={cn(
          "absolute -right-6 top-0 z-10 flex size-6 items-center justify-center rounded border border-border-bright bg-background-hover font-sans",
          asChild && "p-1",
          "pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100",
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
      <span className={cn("group relative inline-flex h-6 items-center", className)}>
        <span>{value}</span>
        {hideTooltip ? (
          iconButton
        ) : (
          // asChild so the Radix trigger merges onto our button instead of nesting a button.
          // tabbable keeps the button in the tab order (the trigger sets tabIndex -1 otherwise).
          <SimpleTooltip
            button={iconButton}
            content={copied ? "Copied!" : "Copy"}
            className="font-sans"
            disableHoverableContent
            tabbable
            asChild
          />
        )}
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
