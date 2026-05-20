import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";
import { useCopy } from "~/hooks/useCopy";
import { cn } from "~/utils/cn";

type CopyTextLinkProps = {
  value: string;
  className?: string;
};

export function CopyTextLink({ value, className }: CopyTextLinkProps) {
  const { copy, copied } = useCopy(value);

  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1 text-xs transition-colors",
        copied
          ? "text-success"
          : "text-text-dimmed hover:text-text-bright",
        className
      )}
    >
      {copied ? "Copied" : "Copy"}
      {copied ? (
        <ClipboardCheckIcon className="size-3" />
      ) : (
        <ClipboardIcon className="size-3" />
      )}
    </button>
  );
}
