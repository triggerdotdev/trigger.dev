import { useCallback, useState } from "react";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";
import { cn } from "~/utils/cn";

export function CopyableText({ value, className }: { value: string; className?: string }) {
  const [isHovered, setIsHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    },
    [value]
  );

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
          content={copied ? "Copied!" : "Copy text"}
          className="font-sans"
          disableHoverableContent
        />
      </span>
    </span>
  );
}
