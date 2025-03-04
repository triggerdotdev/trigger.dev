"use client";

import * as SheetPrimitive from "@radix-ui/react-dialog";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import * as React from "react";
import { cn } from "~/utils/cn";
import { ShortcutKey } from "./ShortcutKey";
import { XMarkIcon } from "@heroicons/react/20/solid";

const Sheet = SheetPrimitive.Root;

const SheetTrigger = SheetPrimitive.Trigger;

const portalVariants = cva("fixed inset-0 z-50 flex", {
  variants: {
    position: {
      top: "items-start",
      bottom: "items-end",
      left: "justify-start",
      right: "justify-end",
    },
  },
  defaultVariants: { position: "right" },
});

interface SheetPortalProps
  extends SheetPrimitive.DialogPortalProps,
    VariantProps<typeof portalVariants> {}

const SheetPortal = ({ position, children, ...props }: SheetPortalProps) => (
  <SheetPrimitive.Portal {...props}>
    <div className={portalVariants({ position })}>{children}</div>
  </SheetPrimitive.Portal>
);
SheetPortal.displayName = SheetPrimitive.Portal.displayName;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, children, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-background-dimmed/80 transition duration-200 animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:fade-in",
      className
    )}
    {...props}
    ref={ref}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

const sheetVariants = cva(
  "fixed z-50 scale-100 gap-4 shadow-lg bg-background-bright opacity-100 border-l border-grid-bright",
  {
    variants: {
      position: {
        top: "animate-in slide-in-from-top w-full duration-200",
        bottom: "animate-in slide-in-from-bottom w-full duration-200",
        left: "animate-in slide-in-from-left h-full duration-200",
        right: "animate-in slide-in-from-right h-screen duration-200",
      },
      size: {
        content: "",
        default: "",
        sm: "",
        lg: "",
        xl: "",
        full: "",
      },
    },
    compoundVariants: [
      {
        position: ["top", "bottom"],
        size: "content",
        class: "max-h-screen",
      },
      {
        position: ["top", "bottom"],
        size: "default",
        class: "h-1/3",
      },
      {
        position: ["top", "bottom"],
        size: "sm",
        class: "h-1/4",
      },
      {
        position: ["top", "bottom"],
        size: "lg",
        class: "h-1/2",
      },
      {
        position: ["top", "bottom"],
        size: "xl",
        class: "h-5/6",
      },
      {
        position: ["top", "bottom"],
        size: "full",
        class: "h-screen",
      },
      {
        position: ["right", "left"],
        size: "content",
        class: "max-w-screen",
      },
      {
        position: ["right", "left"],
        size: "default",
        class: "w-1/3",
      },
      {
        position: ["right", "left"],
        size: "sm",
        class: "w-1/4",
      },
      {
        position: ["right", "left"],
        size: "lg",
        class: "w-1/2",
      },
      {
        position: ["right", "left"],
        size: "xl",
        class: "w-5/6",
      },
      {
        position: ["right", "left"],
        size: "full",
        class: "w-screen",
      },
    ],
    defaultVariants: {
      position: "right",
      size: "default",
    },
  }
);

export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  DialogContentProps
>(({ position, size, className, children, ...props }, ref) => (
  <SheetPortal position={position}>
    <SheetOverlay />
    <SheetPrimitive.Content
      ref={ref}
      className={cn(sheetVariants({ position, size }), className)}
      {...props}
    >
      <div className="grid max-h-full grid-rows-[2.75rem_1fr] overflow-hidden">
        <div className="flex items-center gap-2 border-b border-grid-bright p-2">
          <SheetPrimitive.Close className="rounded-sm p-1 transition hover:bg-charcoal-800 disabled:pointer-events-none">
            <XMarkIcon className="size-4 text-text-dimmed" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
          <ShortcutKey shortcut={{ key: "esc" }} variant="small" />
        </div>
        <div className="flex max-h-full flex-col overflow-hidden">{children}</div>
      </div>
    </SheetPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = SheetPrimitive.Content.displayName;

export const SheetBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600",
      className
    )}
    {...props}
  />
);

export const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "mx-4 flex shrink-0 items-center gap-4 border-b border-grid-bright py-3.5",
      className
    )}
    {...props}
  />
);

export const SheetFooter = ({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("shrink-0", className)} {...props}>
    <div className="mx-4 border-t border-grid-bright py-3">{children}</div>
  </div>
);

export { Sheet, SheetContent, SheetTrigger };
