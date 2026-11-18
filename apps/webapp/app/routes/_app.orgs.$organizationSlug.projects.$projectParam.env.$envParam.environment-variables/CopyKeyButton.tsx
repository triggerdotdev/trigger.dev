import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useCopy } from "~/hooks/useCopy";
import { cn } from "~/utils/cn";

/** Copies the key. Shown while the row is hovered or has focus, and always on touch screens. */
export function CopyKeyButton({ value }: { value: string }) {
  const { copy, copied } = useCopy(value);
  return (
    <SimpleTooltip
      asChild
      tabbable
      disableHoverableContent
      button={
        <button
          type="button"
          aria-label={copied ? `Copied ${value}` : `Copy ${value}`}
          onClick={copy}
          className={cn(
            "flex size-6 items-center justify-center rounded border border-border-bright bg-background-hover opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/table-row:opacity-100 group-hover/table-row:opacity-100 pointer-coarse:opacity-100",
            copied
              ? "text-green-500 opacity-100"
              : "text-text-dimmed hover:bg-background-raised hover:text-text-bright"
          )}
        >
          {copied ? (
            <ClipboardCheckIcon className="size-3.5" />
          ) : (
            <ClipboardIcon className="size-3.5" />
          )}
        </button>
      }
      content={copied ? "Copied" : "Copy"}
    />
  );
}
