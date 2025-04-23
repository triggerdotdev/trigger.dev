import { XMarkIcon } from "@heroicons/react/20/solid";
import { ReactNode } from "react";
import { cn } from "~/utils/cn";

const variants = {
  "tertiary/small": {
    box: "h-6 bg-tertiary rounded pl-1.5 gap-1.5 text-xs divide-x divide-black/15 group-hover:bg-charcoal-600",
    clear: "size-6 text-text-dimmed hover:text-text-bright transition-colors",
  },
  "minimal/small": {
    box: "h-6 hover:bg-tertiary rounded pl-1.5 gap-1.5 text-xs",
    clear: "size-6 text-text-dimmed hover:text-text-bright transition-colors",
  },
};

type Variant = keyof typeof variants;

type AppliedFilterProps = {
  label: ReactNode;
  value: ReactNode;
  removable?: boolean;
  onRemove?: () => void;
  variant?: Variant;
  className?: string;
};

export function AppliedFilter({
  label,
  value,
  removable = true,
  onRemove,
  variant = "tertiary/small",
  className,
}: AppliedFilterProps) {
  const variantClassName = variants[variant];
  return (
    <div
      className={cn(
        "flex items-center transition",
        variantClassName.box,
        !removable && "pr-2",
        className
      )}
    >
      <div className="flex items-center gap-0.5">
        <div className="text-text-dimmed">
          <span>{label}</span>:
        </div>
        <div className="text-text-bright">
          <div>{value}</div>
        </div>
      </div>
      {removable && (
        <button
          className={cn(
            "group flex size-6 items-center justify-center focus-custom",
            variantClassName.clear
          )}
          onClick={onRemove}
        >
          <XMarkIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}
