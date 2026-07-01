import { InformationCircleIcon } from "@heroicons/react/20/solid";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";
import { cn } from "~/utils/cn";

const variantClasses = {
  basic:
    "bg-background-bright border border-grid-bright rounded px-3 py-2 text-sm text-text-bright shadow-md fade-in-50",
  dark: "bg-background-dimmed border border-grid-bright rounded px-3 py-2 text-sm text-text-bright shadow-md fade-in-50",
};

type Variant = keyof typeof variantClasses;

const TooltipProvider = TooltipPrimitive.Provider;

const TooltipArrow = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Arrow>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Arrow>
>(({ ...props }, _ref) => <TooltipPrimitive.Arrow className="fill-popover z-50" {...props} />);
TooltipArrow.displayName = TooltipPrimitive.Arrow.displayName;

const Tooltip = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>
>(({ delayDuration = 0, ...props }, _ref) => (
  <TooltipPrimitive.Root delayDuration={delayDuration} {...props} />
));
Tooltip.displayName = TooltipPrimitive.Root.displayName;

const TooltipTrigger = TooltipPrimitive.Trigger;

type TooltipContentProps = {
  variant?: Variant;
} & React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  TooltipContentProps
>(({ className, sideOffset = 4, variant = "basic", ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden animate-in data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 focus-visible:outline-none",
        variantClasses[variant],
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

function SimpleTooltip({
  button,
  content,
  side,
  hidden,
  variant,
  disableHoverableContent = false,
  className,
  buttonClassName,
  buttonStyle,
  asChild = false,
  sideOffset,
  open,
  onOpenChange,
  delayDuration,
}: {
  button: React.ReactNode;
  content: React.ReactNode;
  side?: React.ComponentProps<typeof TooltipContent>["side"];
  hidden?: boolean;
  variant?: Variant;
  disableHoverableContent?: boolean;
  className?: string;
  buttonClassName?: string;
  buttonStyle?: React.CSSProperties;
  asChild?: boolean;
  sideOffset?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
}) {
  return (
    <TooltipProvider disableHoverableContent={disableHoverableContent}>
      <Tooltip open={open} onOpenChange={onOpenChange} delayDuration={delayDuration}>
        <TooltipTrigger
          type={asChild ? undefined : "button"}
          tabIndex={-1}
          className={cn(!asChild && "h-fit", buttonClassName)}
          style={buttonStyle}
          asChild={asChild}
        >
          {button}
        </TooltipTrigger>
        <TooltipContent
          side={side}
          hidden={hidden}
          sideOffset={sideOffset}
          className={cn("text-xs", className)}
          variant={variant}
        >
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function InfoIconTooltip({
  content,
  buttonClassName,
  contentClassName,
  variant = "basic",
  disableHoverableContent = false,
  enabled = true,
}: {
  content: React.ReactNode;
  buttonClassName?: string;
  contentClassName?: string;
  variant?: Variant;
  disableHoverableContent?: boolean;
  enabled?: boolean;
}) {
  const icon = (
    <InformationCircleIcon className={cn("size-3.5 text-text-dimmed flex-0", buttonClassName)} />
  );

  if (!enabled) return icon;
  return (
    <SimpleTooltip
      button={icon}
      content={content}
      variant={variant}
      className={contentClassName}
      disableHoverableContent={disableHoverableContent}
    />
  );
}

export { SimpleTooltip, Tooltip, TooltipArrow, TooltipContent, TooltipProvider, TooltipTrigger };
