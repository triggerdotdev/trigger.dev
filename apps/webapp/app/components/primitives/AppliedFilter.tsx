import { XMarkIcon } from "@heroicons/react/20/solid";
import { type ReactNode } from "react";
import { cn } from "~/utils/cn";

const variants = {
  "secondary/small": {
    box: "h-6 bg-secondary rounded pl-1.5 gap-1.5 text-xs divide-x divide-black/15 group-hover:bg-charcoal-600 group-hover:border-charcoal-550 text-text-bright border border-charcoal-600",
    clear: "size-6 text-text-bright hover:text-text-bright transition-colors",
  },
  "tertiary/small": {
    box: "h-6 bg-tertiary rounded pl-1.5 gap-1.5 text-xs divide-x divide-black/15 group-hover:bg-charcoal-600",
    clear: "size-6 text-text-dimmed hover:text-text-bright transition-colors",
  },
  "minimal/medium": {
    box: "h-6 rounded gap-1.5 text-sm",
    clear: "size-6 text-text-dimmed transition-colors",
  },
};

type Variant = keyof typeof variants;

type AppliedFilterProps = {
  icon?: ReactNode;
  label: ReactNode;
  value: ReactNode;
  removable?: boolean;
  onRemove?: () => void;
  variant?: Variant;
  className?: string;
};

export function AppliedFilter({
  icon,
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
        <div className="flex items-center gap-1">
          {icon}
          <div className="text-text-bright">
            <span>{label}</span>:
          </div>
        </div>
        <div className="text-text-dimmed">
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
