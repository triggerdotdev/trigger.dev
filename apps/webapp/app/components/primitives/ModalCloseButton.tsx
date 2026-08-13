import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as React from "react";
import { CrossIcon } from "~/assets/icons/CrossIcon";
import { cn } from "~/utils/cn";
import { ShortcutKey } from "./ShortcutKey";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./Tooltip";

const CLOSE_TOOLTIP_DELAY_MS = 500;

/**
 * The close button for modal surfaces — Dialog and Sheet, which are both Radix Dialog underneath.
 * Pass `className` to position it, and to override the default `size-7` box where a surface needs
 * to keep a tighter header height.
 */
export function ModalCloseButton({ className }: { className?: string }) {
  const [open, setOpen] = React.useState(false);
  const openTimeout = React.useRef<ReturnType<typeof setTimeout>>();

  const cancelOpen = () => clearTimeout(openTimeout.current);
  React.useEffect(() => cancelOpen, []);

  const close = () => {
    cancelOpen();
    setOpen(false);
  };

  return (
    <TooltipProvider>
      {/* The tooltip is driven by our own hover timer rather than Radix's: Radix opens tooltips
          instantly on focus, and these surfaces autofocus this button whenever they hold no other
          tabbable content, which would pop the tooltip open on mount and leave it there.
          Radix-initiated opens are ignored; its closes (pointer leave, blur, click) are honoured. */}
      <Tooltip open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
        <TooltipTrigger asChild>
          <DialogPrimitive.Close
            onPointerEnter={(event) => {
              if (event.pointerType === "touch") return;
              cancelOpen();
              openTimeout.current = setTimeout(() => setOpen(true), CLOSE_TOOLTIP_DELAY_MS);
            }}
            onPointerLeave={close}
            className={cn(
              "group flex size-7 items-center justify-center rounded-sm opacity-70 transition focus-custom hover:bg-background-hover hover:opacity-100 focus-visible:focus-custom disabled:pointer-events-none",
              className
            )}
          >
            <CrossIcon className="size-4 text-text-dimmed transition group-hover:text-text-bright" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </TooltipTrigger>
        <TooltipContent className="flex items-center py-1.5 pl-2.5 pr-2 text-xs text-text-bright">
          Close
          <ShortcutKey shortcut={{ key: "esc" }} variant="medium" />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
