import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";
import { useCopy } from "~/hooks/useCopy";
import { cn } from "~/utils/cn";
import { Button } from "./Buttons";
import { SimpleTooltip } from "./Tooltip";

const sizes = {
  "extra-small": {
    icon: "size-3",
    button: "h-5 px-1",
  },
  small: {
    icon: "size-3.5",
    button: "h-6 px-1",
  },
  medium: {
    icon: "size-4",
    button: "h-8 px-1.5",
  },
};

type CopyButtonProps = {
  value: string;
  variant?: "icon" | "button";
  size?: keyof typeof sizes;
  className?: string;
  buttonClassName?: string;
  showTooltip?: boolean;
  buttonVariant?: "primary" | "secondary" | "tertiary" | "minimal";
};

export function CopyButton({
  value,
  variant = "button",
  size = "medium",
  className,
  buttonClassName,
  showTooltip = true,
  buttonVariant = "tertiary",
}: CopyButtonProps) {
  const { copy, copied } = useCopy(value);

  const { icon: iconSize, button: buttonSize } = sizes[size];

  const button =
    variant === "icon" ? (
      <span
        onClick={copy}
        className={cn(
          buttonSize,
          "flex items-center justify-center rounded border border-charcoal-650 bg-charcoal-750",
          copied
            ? "text-green-500"
            : "text-text-dimmed hover:border-charcoal-600 hover:bg-charcoal-700 hover:text-text-bright",
          buttonClassName
        )}
      >
        {copied ? (
          <ClipboardCheckIcon className={iconSize} />
        ) : (
          <ClipboardIcon className={iconSize} />
        )}
      </span>
    ) : (
      <Button
        variant={`${buttonVariant}/${size === "extra-small" ? "small" : size}`}
        onClick={copy}
        className={cn("shrink-0", buttonClassName)}
      >
        {copied ? (
          <ClipboardCheckIcon
            className={cn(
              iconSize,
              buttonVariant === "primary" ? "text-background-dimmed" : "text-green-500"
            )}
          />
        ) : (
          <ClipboardIcon
            className={cn(
              iconSize,
              buttonVariant === "primary" ? "text-background-dimmed" : "text-text-dimmed"
            )}
          />
        )}
      </Button>
    );

  if (!showTooltip) return <span className={className}>{button}</span>;

  return (
    <span className={className}>
      <SimpleTooltip
        button={button}
        content={copied ? "Copied!" : "Copy"}
        className="font-sans"
        disableHoverableContent
      />
    </span>
  );
}
