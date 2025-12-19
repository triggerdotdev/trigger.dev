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
}: {
  value: string;
  copyValue?: string;
  className?: string;
  asChild?: boolean;
  variant?: "icon-right" | "text-below";
}) {
  const [isHovered, setIsHovered] = useState(false);
  const { copy, copied } = useCopy(copyValue ?? value);

  const resolvedVariant = variant ?? "icon-right";

  if (resolvedVariant === "icon-right") {
    return (
      <span
        className={cn("group relative inline-flex h-6 items-center", className)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <span onMouseEnter={() => setIsHovered(true)}>{value}</span>
        <span
          onClick={copy}
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            "absolute -right-6 top-0 z-10 size-6 font-sans",
            isHovered ? "flex" : "hidden"
          )}
        >
          <SimpleTooltip
            button={
              <span
                className={cn(
                  "ml-1 flex size-6 items-center justify-center rounded border border-charcoal-650 bg-charcoal-750",
                  asChild && "p-1",
                  copied
                    ? "text-green-500"
                    : "text-text-dimmed hover:border-charcoal-600 hover:bg-charcoal-700 hover:text-text-bright"
                )}
              >
                {copied ? (
                  <ClipboardCheckIcon className="size-3.5" />
                ) : (
                  <ClipboardIcon className="size-3.5" />
                )}
              </span>
            }
            content={copied ? "Copied!" : "Copy"}
            className="font-sans"
            disableHoverableContent
            asChild={asChild}
          />
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
              "cursor-pointer bg-transparent px-1 py-0 text-left text-text-bright transition-colors hover:bg-transparent hover:text-white",
              className
            )}
          >
            {value}
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
