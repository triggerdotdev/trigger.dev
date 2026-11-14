import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useCopy } from "~/hooks/useCopy";
import { cn } from "~/utils/cn";

/** Copies the key. Shown while the row is hovered or the button has focus. */
export function CopyKeyButton({ value }: { value: string }) {
  const { copy, copied } = useCopy(value);
  return (
    <SimpleTooltip
      asChild
      disableHoverableContent
      button={
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy"}
          onClick={copy}
          className={cn(
            "flex size-6 items-center justify-center rounded border border-border-bright bg-background-hover opacity-0 transition-opacity focus-visible:opacity-100 group-hover/table-row:opacity-100",
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
